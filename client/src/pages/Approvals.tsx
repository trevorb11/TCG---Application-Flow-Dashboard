import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useLocation, Link } from "wouter";
import { LenderAutocomplete } from "@/components/LenderAutocomplete";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Building2,
  DollarSign,
  CheckCircle2,
  Loader2,
  ShieldAlert,
  ArrowLeft,
  Search,
  Pencil,
  Copy,
  Link2,
  ThumbsDown,
  Calendar,
  Save,
  X,
  Plus,
  Trash2,
  Landmark,
  Star,
  Upload,
  FileText,
  Download,
  Eye,
  FolderArchive,
  ChevronDown,
  ChevronUp,
  Banknote,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { StatusToggle } from "@/components/StatusToggle";
import type { BusinessUnderwritingDecision } from "@shared/schema";
import { AGENTS } from "@shared/agents";

interface AuthState {
  isAuthenticated: boolean;
  role?: 'admin' | 'agent' | 'underwriting';
  agentName?: string;
  agentEmail?: string;
}

interface BankStatementUpload {
  id: string;
  email: string;
  businessName: string;
  originalFileName: string;
  fileSize: number;
  createdAt: string;
  source?: string;
}

interface FullApprovalEntry {
  id: string;
  lender: string;
  advanceAmount: string;
  term: string;
  paymentFrequency: string;
  factorRate: string;
  buyRate: string;
  sellRate: string;
  maxUpsell: string;
  minimumDraw?: string; // floor for the Offer Explorer slider (TCG offers)
  numberOfPayments?: string; // manual override for payment count (e.g. 52 for 12-month weekly at 52wk/yr)
  lenderName?: string; // optional display name shown on offer sheet (e.g. "PIRS Capital")
  earlyPayoffEnabled?: boolean;
  earlyPayoffMode?: 'amounts' | 'rates'; // 'amounts' = enter $ values, 'rates' = enter factor rates
  earlyPayoffAmounts?: string[]; // dollar amounts per month as strings for input binding
  earlyPayoffRates?: string[];   // factor rates per month (e.g. "1.15") as strings for input binding
  totalPayback: string;
  netAfterFees: string;
  notes: string;
  approvalDate: string;
  fundedDate: string;
  isPrimary: boolean;
  createdAt: string;
}

// Legacy format for migration
interface LegacyAdditionalApproval {
  lender: string;
  amount: string;
  term: string;
  factorRate: string;
}

function formatCurrency(value: string | number | null | undefined): string {
  if (!value) return "N/A";
  const num = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(num)) return "N/A";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(num);
}

function formatDate(date: string | Date | null | undefined): string {
  if (!date) return "N/A";
  return new Date(date).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function Approvals() {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [accessDenied, setAccessDenied] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authRole, setAuthRole] = useState<string>("");
  const [authAgentName, setAuthAgentName] = useState<string>("");
  const [repFilter, setRepFilter] = useState<string>("all"); // "all" or agent name
  const [searchQuery, setSearchQuery] = useState("");
  const [editingApproval, setEditingApproval] = useState<{
    decision: BusinessUnderwritingDecision;
    approvalId?: string; // undefined = adding new
  } | null>(null);
  const [editForm, setEditForm] = useState({
    assignedRep: '',
    assignedRep2: '',
    advanceAmount: '',
    term: '',
    paymentFrequency: 'weekly',
    factorRate: '',
    buyRate: '',
    sellRate: '',
    maxUpsell: '',
    minimumDraw: '',
    numberOfPayments: '',
    lenderName: '',
    earlyPayoffEnabled: false as boolean,
    earlyPayoffMode: 'amounts' as 'amounts' | 'rates',
    earlyPayoffAmounts: [] as string[],
    earlyPayoffRates: [] as string[],
    totalPayback: '',
    netAfterFees: '',
    lender: '',
    notes: '',
    approvalDate: '',
    fundedDate: '',
    isLineOfCredit: false as boolean,
    creditLineTotal: '',
  });
  const [saving, setSaving] = useState(false);
  
  // CSV upload state
  const [showCsvUpload, setShowCsvUpload] = useState(false);
  const [csvContent, setCsvContent] = useState('');
  const [csvUploading, setCsvUploading] = useState(false);
  const [csvResults, setCsvResults] = useState<{ imported: number; errors: number; results?: any[] } | null>(null);
  const [expandedAdditionalApprovals, setExpandedAdditionalApprovals] = useState<Set<string>>(new Set());

  // Fund dialog state
  const [fundingDecision, setFundingDecision] = useState<BusinessUnderwritingDecision | null>(null);
  const [fundForm, setFundForm] = useState({
    advanceAmount: '',
    term: '',
    paymentFrequency: 'weekly',
    factorRate: '',
    buyRate: '',
    sellRate: '',
    maxUpsell: '',
    totalPayback: '',
    netAfterFees: '',
    lender: '',
    notes: '',
    approvalDate: '',
    fundedDate: new Date().toISOString().split('T')[0],
    isLineOfCredit: false,
    creditLineTotal: '',
  });
  const [fundSaving, setFundSaving] = useState(false);
  const [existingFundingsEdits, setExistingFundingsEdits] = useState<any[]>([]);

  // Check authentication first
  useEffect(() => {
    async function checkAuth() {
      try {
        const res = await fetch("/api/auth/check", { credentials: "include" });
        const data: AuthState = await res.json();
        if (data.isAuthenticated && (data.role === "admin" || data.role === "underwriting" || data.role === "agent")) {
          setIsAuthenticated(true);
          setAuthRole(data.role || "");
          if (data.agentName) setAuthAgentName(data.agentName);
          // Agents default to "My Files" view
          if (data.role === "agent") setRepFilter("mine");
        } else if (data.isAuthenticated) {
          setAccessDenied(true);
        } else {
          setLocation("/dashboard");
        }
      } catch {
        setLocation("/dashboard");
      } finally {
        setAuthChecked(true);
      }
    }
    checkAuth();
  }, [setLocation]);

  // Fetch all underwriting decisions
  const { data: allDecisions, isLoading, error: decisionsError } = useQuery<BusinessUnderwritingDecision[]>({
    queryKey: ["/api/underwriting-decisions", "approved"],
    queryFn: async () => {
      // view=approvals includes funded businesses that still carry approval
      // entries (dual visibility — approvals always live on this page)
      const res = await fetch("/api/underwriting-decisions?view=approvals", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch decisions");
      return res.json();
    },
    retry: false,
    enabled: isAuthenticated,
  });

  // Lightweight cross-status counts for nav badges (avoids fetching all rows)
  const { data: statusCounts } = useQuery<Record<string, number>>({
    queryKey: ["/api/underwriting-decisions", "counts"],
    queryFn: async () => {
      const res = await fetch("/api/underwriting-decisions/counts", { credentials: "include" });
      if (!res.ok) return {};
      return res.json();
    },
    retry: false,
    enabled: isAuthenticated,
  });

  // Helper: get the most recent approval date for a decision
  const getMostRecentApprovalDate = (d: BusinessUnderwritingDecision): number => {
    const dates: number[] = [];

    if (d.approvalDate) {
      dates.push(new Date(d.approvalDate).getTime());
    }

    const approvals = d.additionalApprovals as any[] | null;
    if (approvals) {
      approvals.forEach((appr: any) => {
        if (appr.approvalDate) {
          dates.push(new Date(appr.approvalDate).getTime());
        }
      });
    }

    return dates.length > 0 ? Math.max(...dates) : new Date(d.createdAt || 0).getTime();
  };

  // ── Past/active approval rule ──────────────────────────────────────────
  // Any approval that was already in the system when a funding came in is a
  // PAST approval. Approvals dated after the latest funding are ACTIVE.

  // Latest funding date on a decision (0 = never funded)
  const getLatestFundingDate = (d: BusinessUnderwritingDecision): number => {
    const dates: number[] = [];
    if (d.fundedDate) dates.push(new Date(d.fundedDate).getTime());
    const fundings = (d as any).additionalFundings as any[] | null;
    if (Array.isArray(fundings)) {
      fundings.forEach((f: any) => {
        const raw = f.fundedDate || f.date;
        if (raw) dates.push(new Date(String(raw).includes('T') ? raw : raw + 'T00:00:00').getTime());
      });
    }
    return dates.length > 0 ? Math.max(...dates) : 0;
  };

  const isApprovalPast = (appr: { approvalDate?: string | null; createdAt?: string | null }, latestFunding: number): boolean => {
    if (!latestFunding) return false; // never funded — everything active
    const raw = appr.approvalDate || appr.createdAt;
    const t = raw ? new Date(String(raw).includes('T') ? String(raw) : raw + 'T00:00:00').getTime() : 0;
    return t <= latestFunding;
  };

  // Any approval data at all (JSONB entries or legacy top-level columns)?
  const hasApprovalData = (d: BusinessUnderwritingDecision): boolean => {
    const raw = d.additionalApprovals as any[] | null;
    if (Array.isArray(raw) && raw.length > 0) return true;
    return Boolean(d.advanceAmount || d.lender);
  };

  // At least one approval newer than the latest funding?
  const hasActiveApproval = (d: BusinessUnderwritingDecision): boolean => {
    const latestFunding = getLatestFundingDate(d);
    if (!latestFunding) return true;
    const raw = d.additionalApprovals as any[] | null;
    if (Array.isArray(raw) && raw.length > 0) {
      return raw.some((a: any) => !isApprovalPast(a, latestFunding));
    }
    return !isApprovalPast(
      { approvalDate: d.approvalDate ? String(d.approvalDate) : null, createdAt: d.createdAt ? String(d.createdAt) : null },
      latestFunding
    );
  };

  // Dual visibility: approved businesses + funded businesses that still carry
  // approvals. Merchants with active approvals sort to the top; past-only sink.
  const approvedDecisions = (allDecisions || [])
    .filter(d => (d.status === "approved" || d.status === "funded") && hasApprovalData(d))
    .sort((a, b) => {
      const aActive = hasActiveApproval(a) ? 1 : 0;
      const bActive = hasActiveApproval(b) ? 1 : 0;
      if (aActive !== bActive) return bActive - aActive;
      return getMostRecentApprovalDate(b) - getMostRecentApprovalDate(a);
    });

  // Filter by rep
  const repFilteredDecisions = repFilter === "all" ? approvedDecisions : approvedDecisions.filter(d => {
    const filterName = repFilter === "mine" ? authAgentName : repFilter;
    if (!filterName) return true;
    const nameLC = filterName.toLowerCase();
    if ((d.assignedRep || "").toLowerCase() === nameLC) return true;
    if (Array.isArray(d.repFollowers) && d.repFollowers.some((f: string) => f.toLowerCase() === nameLC)) return true;
    return false;
  });

  // Filter by search
  const filteredDecisions = repFilteredDecisions.filter(d => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase().trim();
    return (
      (d.businessName || "").toLowerCase().includes(q) ||
      (d.businessEmail || "").toLowerCase().includes(q) ||
      (d.lender || "").toLowerCase().includes(q)
    );
  });

  const { data: bankUploads } = useQuery<BankStatementUpload[]>({
    queryKey: ['/api/bank-statements/uploads'],
    queryFn: async () => {
      const res = await fetch('/api/bank-statements/uploads', { credentials: 'include' });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: isAuthenticated,
  });

  const [expandedStatements, setExpandedStatements] = useState<Set<string>>(new Set());

  const getUploadsForEmail = (email: string): BankStatementUpload[] => {
    if (!email || !bankUploads) return [];
    return bankUploads.filter(u => u.email.toLowerCase() === email.toLowerCase());
  };

  const handleViewStatement = (uploadId: string) => {
    window.open(`/api/bank-statements/view/${uploadId}`, '_blank');
  };

  const handleDownloadStatement = async (uploadId: string, fileName: string) => {
    try {
      const res = await fetch(`/api/bank-statements/download/${uploadId}`, { credentials: 'include' });
      if (!res.ok) throw new Error('Download failed');
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (error) {
      console.error('Download error:', error);
    }
  };

  const handleViewAllStatements = async (email: string) => {
    try {
      const res = await fetch(`/api/bank-statements/view-url?email=${encodeURIComponent(email)}`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        window.open(data.url, '_blank');
      }
    } catch (err) {
      console.error('Failed to get view URL:', err);
    }
  };

  const handleBulkDownloadStatements = async (businessName: string) => {
    try {
      const res = await fetch(`/api/bank-statements/download-all/${encodeURIComponent(businessName)}`, { credentials: 'include' });
      if (!res.ok) throw new Error('Bulk download failed');
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const safeBusinessName = businessName.replace(/[^a-zA-Z0-9-_]/g, '_').substring(0, 50);
      a.download = `${safeBusinessName}_Bank_Statements.zip`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (error) {
      console.error('Bulk download error:', error);
    }
  };

  const toggleStatements = (id: string) => {
    setExpandedStatements(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  // Approval-entry totals: all-time vs still-active
  const approvalEntryStats = approvedDecisions.reduce(
    (acc, d) => {
      const entries = d.additionalApprovals as any[] | null;
      const list = Array.isArray(entries) && entries.length > 0
        ? entries
        : (d.advanceAmount || d.lender ? [{ approvalDate: d.approvalDate ? String(d.approvalDate) : null, createdAt: d.createdAt ? String(d.createdAt) : null }] : []);
      const latestFunding = getLatestFundingDate(d);
      for (const a of list) {
        acc.allTime++;
        if (!isApprovalPast(a, latestFunding)) acc.active++;
      }
      return acc;
    },
    { allTime: 0, active: 0 }
  );

  // Compute stats from approved decisions
  const stats = {
    totalApproved: approvedDecisions.filter(d => hasActiveApproval(d)).length,
    activeApprovals: approvalEntryStats.active,
    allTimeApprovals: approvalEntryStats.allTime,
    totalAmount: approvedDecisions.reduce((sum, d) => sum + (parseFloat(d.advanceAmount?.toString() || "0") || 0), 0),
    totalDeclined: statusCounts?.declined ?? 0,
  };

  // Helper: get all approvals for a decision (migration-aware)
  const getApprovalsForDecision = (decision: BusinessUnderwritingDecision): FullApprovalEntry[] => {
    const raw = decision.additionalApprovals as any[] | null;

    // Check if already in new format (has isPrimary field)
    if (raw && raw.length > 0 && raw[0].isPrimary !== undefined) {
      return raw as FullApprovalEntry[];
    }

    // Migration: convert old format to new
    const result: FullApprovalEntry[] = [];

    if (decision.advanceAmount || decision.lender) {
      result.push({
        id: 'primary-' + decision.id,
        lender: decision.lender || '',
        advanceAmount: decision.advanceAmount?.toString() || '',
        term: decision.term || '',
        paymentFrequency: decision.paymentFrequency || 'weekly',
        factorRate: decision.factorRate?.toString() || '',
        buyRate: (decision as any).buyRate?.toString() || '',
        sellRate: (decision as any).sellRate?.toString() || '',
        maxUpsell: decision.maxUpsell?.toString() || '',
        totalPayback: decision.totalPayback?.toString() || '',
        netAfterFees: decision.netAfterFees?.toString() || '',
        notes: decision.notes || '',
        approvalDate: decision.approvalDate ? new Date(decision.approvalDate).toISOString().split('T')[0] : '',
        fundedDate: decision.fundedDate ? new Date(decision.fundedDate).toISOString().split('T')[0] : '',
        isPrimary: true,
        createdAt: decision.createdAt ? new Date(decision.createdAt).toISOString() : new Date().toISOString(),
      });
    }

    if (raw) {
      raw.forEach((old: any, idx: number) => {
        result.push({
          id: 'migrated-' + idx,
          lender: old.lender || '',
          advanceAmount: old.amount || old.advanceAmount || '',
          term: old.term || '',
          paymentFrequency: old.paymentFrequency || 'weekly',
          factorRate: old.factorRate || '',
          buyRate: old.buyRate || '',
          sellRate: old.sellRate || '',
          maxUpsell: old.maxUpsell || '',
          totalPayback: old.totalPayback || '',
          netAfterFees: old.netAfterFees || '',
          notes: old.notes || '',
          approvalDate: old.approvalDate || '',
          fundedDate: old.fundedDate || '',
          isPrimary: false,
          createdAt: new Date().toISOString(),
        });
      });
    }

    return result;
  };

  const generateApprovalId = () => `appr-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

  // Update mutation
  const updateMutation = useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: Record<string, any> }) => {
      const res = await fetch(`/api/underwriting-decisions/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(updates),
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(errorData.error || `Server returned ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/underwriting-decisions"] });
      toast({ title: "Updated", description: "Approval details have been saved." });
      setEditingApproval(null);
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message || "Failed to update approval details.", variant: "destructive" });
    },
  });

  // CSV bulk import handler
  const handleCsvUpload = async () => {
    if (!csvContent.trim()) {
      toast({ title: "Error", description: "Please paste CSV content or upload a file.", variant: "destructive" });
      return;
    }
    
    setCsvUploading(true);
    setCsvResults(null);
    
    try {
      const res = await fetch('/api/underwriting-decisions/bulk-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ csvData: csvContent }),
      });
      
      const data = await res.json();
      
      if (!res.ok) {
        throw new Error(data.error || 'Failed to import');
      }
      
      setCsvResults({ imported: data.imported, errors: data.errors, results: data.results });
      queryClient.invalidateQueries({ queryKey: ["/api/underwriting-decisions"] });
      
      if (data.errors === 0) {
        toast({ title: "Success", description: `Imported ${data.imported} approvals successfully.` });
      } else {
        toast({ 
          title: "Partial Success", 
          description: `Imported ${data.imported} approvals with ${data.errors} errors.`,
          variant: "default" 
        });
      }
    } catch (error: any) {
      toast({ title: "Import Failed", description: error.message, variant: "destructive" });
    } finally {
      setCsvUploading(false);
    }
  };
  
  // Handle file upload for CSV
  const handleCsvFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      setCsvContent(content);
    };
    reader.readAsText(file);
  };

  const openEditDialog = (decision: BusinessUnderwritingDecision, approvalId?: string) => {
    if (approvalId) {
      const approvals = getApprovalsForDecision(decision);
      const existing = approvals.find(a => a.id === approvalId);
      if (existing) {
        setEditForm({
          assignedRep: decision.assignedRep || '',
          assignedRep2: (decision as any).assignedRep2 || '',
          advanceAmount: existing.advanceAmount,
          term: existing.term,
          paymentFrequency: existing.paymentFrequency || 'weekly',
          factorRate: existing.factorRate,
          buyRate: existing.buyRate || '',
          sellRate: existing.sellRate || '',
          maxUpsell: existing.maxUpsell || '',
          minimumDraw: existing.minimumDraw || '',
          numberOfPayments: existing.numberOfPayments || '',
          lenderName: existing.lenderName || '',
          earlyPayoffEnabled: existing.earlyPayoffEnabled || false,
          earlyPayoffMode: (existing.earlyPayoffMode as 'amounts' | 'rates') || 'amounts',
          earlyPayoffAmounts: (existing.earlyPayoffAmounts || []).map(String),
          earlyPayoffRates: (existing.earlyPayoffRates || []).map(String),
          totalPayback: existing.totalPayback,
          netAfterFees: existing.netAfterFees,
          lender: existing.lender,
          notes: existing.notes,
          approvalDate: existing.approvalDate || '',
          fundedDate: existing.fundedDate || '',
          isLineOfCredit: (decision as any).isLineOfCredit || false,
          creditLineTotal: (decision as any).creditLineTotal?.toString() || '',
        });
      }
    } else {
      setEditForm({
        assignedRep: decision.assignedRep || '',
        assignedRep2: (decision as any).assignedRep2 || '',
        advanceAmount: '',
        term: '',
        paymentFrequency: 'weekly',
        factorRate: '',
        buyRate: '',
        sellRate: '',
        maxUpsell: '',
        minimumDraw: '',
        numberOfPayments: '',
        lenderName: '',
        earlyPayoffEnabled: false,
        earlyPayoffMode: 'amounts' as 'amounts' | 'rates',
        earlyPayoffAmounts: [],
        earlyPayoffRates: [],
        totalPayback: '',
        netAfterFees: '',
        lender: '',
        notes: '',
        approvalDate: new Date().toISOString().split('T')[0],
        fundedDate: '',
        isLineOfCredit: (decision as any).isLineOfCredit || false,
        creditLineTotal: (decision as any).creditLineTotal?.toString() || '',
      });
    }
    setEditingApproval({ decision, approvalId });
  };

  const handleSaveEdit = async () => {
    if (!editingApproval) return;
    setSaving(true);
    try {
      const { decision, approvalId } = editingApproval;
      let approvals = getApprovalsForDecision(decision);

      const newEntry: FullApprovalEntry = {
        id: approvalId || generateApprovalId(),
        lender: editForm.lender,
        advanceAmount: editForm.advanceAmount,
        term: editForm.term,
        paymentFrequency: editForm.paymentFrequency,
        factorRate: editForm.factorRate,
        buyRate: editForm.buyRate,
        sellRate: editForm.sellRate,
        maxUpsell: editForm.maxUpsell,
        minimumDraw: editForm.minimumDraw,
        numberOfPayments: editForm.numberOfPayments || undefined,
        lenderName: editForm.lenderName || undefined,
        earlyPayoffEnabled: editForm.earlyPayoffEnabled,
        earlyPayoffMode: editForm.earlyPayoffEnabled ? editForm.earlyPayoffMode : undefined,
        earlyPayoffAmounts: editForm.earlyPayoffEnabled && editForm.earlyPayoffMode === 'amounts' && editForm.earlyPayoffAmounts.length > 0
          ? editForm.earlyPayoffAmounts.filter(v => { const n = parseFloat(v); return !isNaN(n) && n > 0; })
          : undefined,
        earlyPayoffRates: editForm.earlyPayoffEnabled && editForm.earlyPayoffMode === 'rates' && editForm.earlyPayoffRates.length > 0
          ? editForm.earlyPayoffRates.filter(v => { const n = parseFloat(v); return !isNaN(n) && n > 0; })
          : undefined,
        totalPayback: editForm.totalPayback,
        netAfterFees: editForm.netAfterFees,
        notes: editForm.notes,
        approvalDate: editForm.approvalDate,
        fundedDate: editForm.fundedDate,
        isPrimary: approvals.length === 0,
        createdAt: approvalId
          ? (approvals.find(a => a.id === approvalId)?.createdAt || new Date().toISOString())
          : new Date().toISOString(),
      };

      if (approvalId) {
        const wasEdited = approvals.find(a => a.id === approvalId);
        newEntry.isPrimary = wasEdited?.isPrimary || false;
        approvals = approvals.map(a => a.id === approvalId ? newEntry : a);
      } else {
        approvals.push(newEntry);
      }

      const updates: Record<string, unknown> = { additionalApprovals: approvals };
      if (editForm.assignedRep !== (decision.assignedRep || '')) {
        updates.assignedRep = editForm.assignedRep || null;
      }
      if (editForm.assignedRep2 !== ((decision as any).assignedRep2 || '')) {
        updates.assignedRep2 = editForm.assignedRep2 || null;
      }
      // Decision-level LOC settings
      updates.isLineOfCredit = editForm.isLineOfCredit;
      updates.creditLineTotal = editForm.isLineOfCredit && editForm.creditLineTotal
        ? parseFloat(editForm.creditLineTotal)
        : null;
      await updateMutation.mutateAsync({
        id: decision.id,
        updates,
      });
    } finally {
      setSaving(false);
    }
  };

  // Set an approval as primary
  const handleSetPrimary = async (decision: BusinessUnderwritingDecision, approvalId: string) => {
    const approvals = getApprovalsForDecision(decision).map(a => ({
      ...a,
      isPrimary: a.id === approvalId,
    }));
    try {
      await updateMutation.mutateAsync({
        id: decision.id,
        updates: { additionalApprovals: approvals },
      });
    } catch (error) {
      console.error('Error setting primary:', error);
    }
  };

  // Delete an individual approval
  const handleDeleteApproval = async (decision: BusinessUnderwritingDecision, approvalId: string) => {
    let approvals = getApprovalsForDecision(decision).filter(a => a.id !== approvalId);

    if (approvals.length > 0 && !approvals.some(a => a.isPrimary)) {
      approvals[0].isPrimary = true;
    }

    try {
      if (approvals.length === 0) {
        const res = await fetch(`/api/underwriting-decisions/${decision.id}`, {
          method: 'DELETE',
          credentials: 'include',
        });
        if (res.ok) {
          queryClient.invalidateQueries({ queryKey: ["/api/underwriting-decisions"] });
          toast({ title: "Removed", description: "All approvals removed" });
        }
      } else {
        await updateMutation.mutateAsync({
          id: decision.id,
          updates: { additionalApprovals: approvals },
        });
      }
    } catch (error) {
      console.error('Error deleting approval:', error);
    }
  };

  // Open Fund dialog with primary approval pre-filled
  const openFundDialog = (decision: BusinessUnderwritingDecision) => {
    const approvals = getApprovalsForDecision(decision);
    const primary = approvals.find(a => a.isPrimary) || approvals[0];
    setFundForm({
      advanceAmount: primary?.advanceAmount || decision.advanceAmount?.toString() || '',
      term: primary?.term || decision.term || '',
      paymentFrequency: primary?.paymentFrequency || decision.paymentFrequency || 'weekly',
      factorRate: primary?.factorRate || decision.factorRate?.toString() || '',
      buyRate: primary?.buyRate || (decision as any).buyRate?.toString() || '',
      sellRate: primary?.sellRate || (decision as any).sellRate?.toString() || '',
      maxUpsell: primary?.maxUpsell || decision.maxUpsell?.toString() || '',
      totalPayback: primary?.totalPayback || decision.totalPayback?.toString() || '',
      netAfterFees: primary?.netAfterFees || decision.netAfterFees?.toString() || '',
      lender: primary?.lender || decision.lender || '',
      notes: primary?.notes || decision.notes || '',
      approvalDate: primary?.approvalDate || (decision.approvalDate ? new Date(decision.approvalDate).toISOString().split('T')[0] : ''),
      fundedDate: new Date().toISOString().split('T')[0],
      isLineOfCredit: (decision as any).isLineOfCredit || false,
      creditLineTotal: (decision as any).creditLineTotal?.toString() || '',
    });
    // Initialize existing fundings edits so admin can toggle portal visibility
    const existingFundings = Array.isArray(decision.additionalFundings) ? (decision.additionalFundings as any[]) : [];
    setExistingFundingsEdits(existingFundings.map((f: any) => ({ ...f })));
    setFundingDecision(decision);
  };

  // Save funded deal
  const handleSaveFund = async () => {
    if (!fundingDecision) return;
    setFundSaving(true);
    try {
      // Build a funded entry from the form values — do NOT mutate the approval packages
      const fundedEntry = {
        id: crypto.randomUUID(),
        lender: fundForm.lender || null,
        advanceAmount: fundForm.advanceAmount || null,
        term: fundForm.term || null,
        paymentFrequency: fundForm.paymentFrequency || null,
        factorRate: fundForm.factorRate || null,
        buyRate: fundForm.buyRate || null,
        sellRate: fundForm.sellRate || null,
        maxUpsell: fundForm.maxUpsell || null,
        totalPayback: fundForm.totalPayback || null,
        netAfterFees: fundForm.netAfterFees || null,
        notes: fundForm.notes || null,
        fundedDate: fundForm.fundedDate
          ? new Date(fundForm.fundedDate + 'T12:00:00').toISOString()
          : new Date().toISOString(),
        assignedRep: null,
        createdAt: new Date().toISOString(),
      };

      // Prepend new entry to existing funded entries (newest first), preserving any hiddenFromPortal edits
      const mergedFundings = [fundedEntry, ...existingFundingsEdits];

      await updateMutation.mutateAsync({
        id: fundingDecision.id,
        updates: {
          status: 'funded',
          fundedDate: fundForm.fundedDate,
          additionalFundings: mergedFundings,
          // Save LOC settings alongside the funding so they're always in sync
          isLineOfCredit: fundForm.isLineOfCredit,
          creditLineTotal: fundForm.isLineOfCredit && fundForm.creditLineTotal
            ? parseFloat(fundForm.creditLineTotal)
            : null,
          // additionalApprovals intentionally omitted — approval packages are never touched when funding
        },
      });
      setFundingDecision(null);
      toast({ title: "Deal Funded", description: `${fundingDecision.businessName || fundingDecision.businessEmail} has been marked as funded.` });
    } catch (error: any) {
      toast({ title: "Error", description: error.message || "Failed to mark deal as funded.", variant: "destructive" });
    } finally {
      setFundSaving(false);
    }
  };

  // Save only portal visibility changes on existing fundings (no new funding added)
  const handleSaveVisibilityOnly = async () => {
    if (!fundingDecision) return;
    setFundSaving(true);
    try {
      await updateMutation.mutateAsync({
        id: fundingDecision.id,
        updates: { additionalFundings: existingFundingsEdits },
      });
      setFundingDecision(null);
      toast({ title: "Portal visibility updated", description: "Merchant portal will now reflect these changes." });
    } catch (error: any) {
      toast({ title: "Error", description: error.message || "Failed to update.", variant: "destructive" });
    } finally {
      setFundSaving(false);
    }
  };

  const copyApprovalUrl = (slug: string) => {
    const url = `${window.location.origin}/approved/${slug}`;
    navigator.clipboard.writeText(url);
    toast({ title: "URL Copied", description: "Approval letter URL copied to clipboard" });
  };

  // Export approvals to CSV
  const handleExportCsv = () => {
    if (approvedDecisions.length === 0) {
      toast({ title: "No Data", description: "No approved businesses to export.", variant: "destructive" });
      return;
    }

    // CSV headers
    const headers = [
      "Business Name",
      "Email",
      "Phone",
      "Lender",
      "Advance Amount",
      "Term",
      "Payment Frequency",
      "Factor Rate",
      "Max Upsell",
      "Total Payback",
      "Net After Fees",
      "Approval Date",
      "Is Primary",
      "Notes",
      "Approval Letter URL",
      "Created At"
    ];

    // Build CSV rows - one row per approval (a business may have multiple approvals)
    const rows: string[][] = [];
    
    approvedDecisions.forEach((decision) => {
      const approvals = getApprovalsForDecision(decision);
      const approvalLetterUrl = decision.approvalSlug 
        ? `${window.location.origin}/approved/${decision.approvalSlug}`
        : "";
      
      if (approvals.length === 0) {
        rows.push([
          decision.businessName ?? "", decision.businessEmail ?? "", decision.businessPhone ?? "",
          "", "", "", "", "", "", "", "", "", "", "", approvalLetterUrl,
          decision.createdAt ? new Date(decision.createdAt).toLocaleDateString() : ""
        ]);
      } else {
        approvals.forEach((approval) => {
          try {
            rows.push([
              decision.businessName ?? "", decision.businessEmail ?? "", decision.businessPhone ?? "",
              approval.lender ?? "", String(approval.advanceAmount ?? ""), approval.term ?? "",
              approval.paymentFrequency ?? "", String(approval.factorRate ?? ""),
              String(approval.maxUpsell ?? ""), String(approval.totalPayback ?? ""),
              String(approval.netAfterFees ?? ""), approval.approvalDate ?? "",
              approval.isPrimary ? "Yes" : "No", approval.notes ?? "", approvalLetterUrl,
              approval.createdAt ? new Date(approval.createdAt).toLocaleDateString() : ""
            ]);
          } catch { /* skip malformed approval entry */ }
        });
      }
    });

    // Escape CSV values (handle null/undefined safely)
    const escapeCsvValue = (value: any) => {
      const str = String(value ?? "");
      if (str.includes(",") || str.includes('"') || str.includes("\n")) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    // Build CSV content
    const csvContent = [
      headers.join(","),
      ...rows.map(row => row.map(escapeCsvValue).join(","))
    ].join("\n");

    // Create and download file
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", `approved-businesses-${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = "hidden";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    toast({ title: "Export Complete", description: `Exported ${rows.length} approval records to CSV.` });
  };

  // Check for 403 errors
  useEffect(() => {
    if (decisionsError && (decisionsError as any).message?.includes("403")) {
      setAccessDenied(true);
    }
  }, [decisionsError]);

  // Show loading while checking auth
  if (!authChecked) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Access denied view
  if (accessDenied) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="max-w-md w-full p-8 text-center">
          <ShieldAlert className="w-16 h-16 mx-auto text-red-500 dark:text-red-400 mb-4" />
          <h1 className="text-2xl font-bold mb-2">Access Denied</h1>
          <p className="text-muted-foreground mb-6">
            This page is only accessible to administrators. Please contact your admin if you need access.
          </p>
          <Button onClick={() => setLocation("/dashboard")} data-testid="button-back-dashboard">
            Return to Dashboard
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background p-4 md:p-8">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setLocation("/dashboard")}
                data-testid="button-back"
              >
                <ArrowLeft className="w-5 h-5" />
              </Button>
              <div>
                <h1 className="text-2xl font-bold" data-testid="heading-approvals">
                  Approved Businesses
                </h1>
                <p className="text-muted-foreground">
                  Businesses approved from the bank statements review
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <Button
                onClick={() => setLocation('/internal-upload')}
                className="flex items-center gap-2"
                data-testid="button-add-approval"
              >
                <Plus className="w-4 h-4" />
                Add Approval
              </Button>
              <Button
                variant="outline"
                onClick={handleExportCsv}
                className="flex items-center gap-2"
                data-testid="button-csv-export"
              >
                <Download className="w-4 h-4" />
                Export CSV
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setShowCsvUpload(true);
                  setCsvContent('');
                  setCsvResults(null);
                }}
                className="flex items-center gap-2"
                data-testid="button-csv-import"
              >
                <Upload className="w-4 h-4" />
                CSV Import
              </Button>
              <Button
                variant="outline"
                onClick={() => setLocation("/declines")}
                className="flex items-center gap-2"
                data-testid="button-view-declines"
              >
                <ThumbsDown className="w-4 h-4" />
                View Declines ({stats.totalDeclined})
              </Button>
              <Button
                variant="outline"
                onClick={() => setLocation("/funded")}
                className="flex items-center gap-2"
                data-testid="button-view-funded"
              >
                <Banknote className="w-4 h-4" />
                View Funded ({statusCounts?.funded ?? 0})
              </Button>
            </div>
          </div>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-green-100 rounded-lg dark:bg-green-900">
                  <CheckCircle2 className="w-5 h-5 text-green-600 dark:text-green-400" />
                </div>
                <div>
                  <div className="text-2xl font-bold" data-testid="text-active-approvals">
                    {stats.activeApprovals}
                  </div>
                  <div className="text-sm text-muted-foreground">Active Approvals</div>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-slate-100 rounded-lg dark:bg-slate-800">
                  <FileText className="w-5 h-5 text-slate-600 dark:text-slate-400" />
                </div>
                <div>
                  <div className="text-2xl font-bold" data-testid="text-alltime-approvals">
                    {stats.allTimeApprovals}
                  </div>
                  <div className="text-sm text-muted-foreground">All-Time Approvals</div>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-blue-100 rounded-lg dark:bg-blue-900">
                  <DollarSign className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                </div>
                <div>
                  <div className="text-2xl font-bold" data-testid="text-total-amount">
                    {formatCurrency(stats.totalAmount)}
                  </div>
                  <div className="text-sm text-muted-foreground">Total Approved Amount</div>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-red-100 rounded-lg dark:bg-red-900">
                  <ThumbsDown className="w-5 h-5 text-red-600 dark:text-red-400" />
                </div>
                <div>
                  <div className="text-2xl font-bold" data-testid="text-total-declines">
                    {stats.totalDeclined}
                  </div>
                  <div className="text-sm text-muted-foreground">Declined Businesses</div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
          <div className="flex gap-2">
            <Button
              variant={repFilter === "all" ? "default" : "outline"}
              size="sm"
              onClick={() => setRepFilter("all")}
            >
              All ({approvedDecisions.length})
            </Button>
            {authAgentName && (
              <Button
                variant={repFilter === "mine" ? "default" : "outline"}
                size="sm"
                onClick={() => setRepFilter("mine")}
              >
                My Files
              </Button>
            )}
            {(authRole === "admin" || authRole === "underwriting") && (
              <Select value={repFilter === "all" || repFilter === "mine" ? "" : repFilter} onValueChange={(v) => setRepFilter(v || "all")}>
                <SelectTrigger className="w-[180px] h-9">
                  <SelectValue placeholder="Filter by rep..." />
                </SelectTrigger>
                <SelectContent>
                  {AGENTS.map(agent => (
                    <SelectItem key={agent.email} value={agent.name}>{agent.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="relative w-full sm:w-96">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              type="text"
              placeholder="Search by business name, email, or lender..."
              value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
            data-testid="input-search"
          />
          </div>
        </div>

        {/* Approvals List */}
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
          </div>
        ) : filteredDecisions.length === 0 ? (
          <Card className="p-12 text-center">
            <CheckCircle2 className="w-12 h-12 mx-auto mb-4 opacity-50 text-muted-foreground" />
            <p className="text-muted-foreground">
              {searchQuery ? "No approved businesses match your search" : "No approved businesses yet"}
            </p>
            <p className="text-sm text-muted-foreground mt-1">
              Approvals are managed from the bank statements section of the dashboard
            </p>
          </Card>
        ) : (
          <div className="space-y-4">
            {filteredDecisions.map((decision, decisionIdx) => {
              const approvals = getApprovalsForDecision(decision);
              // Divider before the first merchant whose approvals are ALL past
              const isFirstPastOnly = !hasActiveApproval(decision) &&
                (decisionIdx === 0 || hasActiveApproval(filteredDecisions[decisionIdx - 1]));
              return (
                <div key={decision.id}>
                {isFirstPastOnly && (
                  <div className="flex items-center gap-3 pt-4 pb-2" data-testid="divider-past-approvals">
                    <div className="h-px flex-1 bg-border" />
                    <span className="text-sm font-medium text-muted-foreground">Past Approvals Only — already funded</span>
                    <div className="h-px flex-1 bg-border" />
                  </div>
                )}
                <Card className="p-6 hover-elevate" data-testid={`card-approval-${decision.id}`}>
                  <div className="flex flex-col gap-4">
                    {/* Business header */}
                    <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
                      <div className="flex items-center gap-3 flex-wrap">
                        <h3 className="font-semibold text-lg flex items-center gap-2">
                          <Building2 className="w-5 h-5 text-primary" />
                          {decision.businessName || decision.businessEmail}
                        </h3>
                        {decision.status === 'funded' ? (
                          <Badge className="bg-purple-600 hover:bg-purple-700 flex items-center gap-1">
                            <Banknote className="w-3 h-3" />
                            Funded
                          </Badge>
                        ) : (
                          <Badge className="bg-green-600 hover:bg-green-700 flex items-center gap-1">
                            <CheckCircle2 className="w-3 h-3" />
                            Approved
                          </Badge>
                        )}
                        <Badge variant="secondary" className="text-xs">
                          {approvals.length} {approvals.length === 1 ? 'Approval' : 'Approvals'}
                        </Badge>
                        {decision.approvalSlug && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => copyApprovalUrl(decision.approvalSlug!)}
                            className="text-primary border-primary/30 hover:bg-primary/10"
                            data-testid={`button-copy-url-${decision.id}`}
                          >
                            <Copy className="w-3 h-3 mr-1" />
                            Copy Letter URL
                          </Button>
                        )}
                        {decision.approvalSlug && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => window.open(`/approved/${decision.approvalSlug}`, '_blank')}
                            data-testid={`button-view-letter-${decision.id}`}
                          >
                            <Link2 className="w-3 h-3 mr-1" />
                            View Letter
                          </Button>
                        )}
                        {decision.approvalSlug && approvals.some(a => /today\s*capital|\btcg\b/i.test(a.lender || '')) && (
                          <>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                navigator.clipboard.writeText(`${window.location.origin}/offer/${decision.approvalSlug}`);
                                toast({ title: "URL Copied", description: "Offer explorer URL copied to clipboard" });
                              }}
                              className="text-teal-600 border-teal-600/30 hover:bg-teal-600/10"
                              data-testid={`button-copy-offer-${decision.id}`}
                            >
                              <Copy className="w-3 h-3 mr-1" />
                              Copy Offer URL
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => window.open(`/offer/${decision.approvalSlug}`, '_blank')}
                              data-testid={`button-view-offer-${decision.id}`}
                            >
                              <Link2 className="w-3 h-3 mr-1" />
                              Offer Page
                            </Button>
                          </>
                        )}
                      </div>
                      <div className="flex gap-2">
                        {decision.businessEmail && (
                          <Link href={`/merchant-profile/${encodeURIComponent(decision.businessEmail)}`}>
                            <Button variant="outline" size="sm" data-testid={`button-profile-${decision.id}`}>
                              <Building2 className="w-4 h-4 mr-1" />
                              Profile
                            </Button>
                          </Link>
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => openEditDialog(decision)}
                          data-testid={`button-add-approval-${decision.id}`}
                        >
                          <Plus className="w-4 h-4 mr-1" />
                          Add Approval
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => openFundDialog(decision)}
                          className="bg-emerald-600 text-white"
                          data-testid={`button-fund-${decision.id}`}
                        >
                          <Banknote className="w-4 h-4 mr-1" />
                          Fund
                        </Button>
                        <StatusToggle decision={decision} currentStatus={(decision.status === 'funded' ? 'funded' : 'approved') as any} />
                      </div>
                    </div>

                    <div className="text-sm text-muted-foreground">
                      {decision.businessEmail}
                    </div>

                    {/* Approvals — active vs past. Rule: any approval that was
                        already in the system when a funding came in is PAST. */}
                    {(() => {
                      const latestFunding = getLatestFundingDate(decision);
                      const isPastApproval = (appr: FullApprovalEntry) => isApprovalPast(appr, latestFunding);

                      const recentApprovals = approvals
                        .filter(a => !isPastApproval(a))
                        .sort((a, b) => (a.isPrimary ? -1 : b.isPrimary ? 1 : 0));
                      const pastApprovals = approvals
                        .filter(a => isPastApproval(a))
                        .sort((a, b) => {
                          const tA = a.approvalDate ? new Date(a.approvalDate.includes('T') ? a.approvalDate : a.approvalDate + 'T00:00:00').getTime() : 0;
                          const tB = b.approvalDate ? new Date(b.approvalDate.includes('T') ? b.approvalDate : b.approvalDate + 'T00:00:00').getTime() : 0;
                          return tB - tA; // newest past first
                        });

                      const isPastExpanded = expandedAdditionalApprovals.has(decision.id + '-past');

                      const renderApproval = (appr: FullApprovalEntry, dimmed = false) => (
                        <div
                          key={appr.id}
                          className={`p-4 rounded-lg border ${
                            dimmed
                              ? 'bg-muted/20 border-transparent opacity-70'
                              : appr.isPrimary
                                ? 'bg-green-50 border-green-200 dark:bg-green-900/20 dark:border-green-800'
                                : 'bg-muted/30 border-transparent'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-3 mb-3">
                            <div className="flex items-center gap-2">
                              {!dimmed && (
                                <button
                                  onClick={() => handleSetPrimary(decision, appr.id)}
                                  className={`flex-shrink-0 ${appr.isPrimary ? 'text-yellow-500' : 'text-muted-foreground hover:text-yellow-500'}`}
                                  title={appr.isPrimary ? 'Best approval' : 'Set as best approval'}
                                  data-testid={`button-set-primary-${appr.id}`}
                                >
                                  <Star className={`w-4 h-4 ${appr.isPrimary ? 'fill-yellow-500' : ''}`} />
                                </button>
                              )}
                              {appr.isPrimary && !dimmed && (
                                <Badge className="bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300 text-xs">
                                  Best Approval
                                </Badge>
                              )}
                              <span className={`font-semibold flex items-center gap-1 ${dimmed ? 'text-muted-foreground' : ''}`}>
                                <Landmark className="w-3 h-3 text-muted-foreground" />
                                {appr.lender || 'No lender'}
                              </span>
                            </div>
                            <div className="flex items-center gap-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => openEditDialog(decision, appr.id)}
                                data-testid={`button-edit-approval-${appr.id}`}
                              >
                                <Pencil className="w-3 h-3" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleDeleteApproval(decision, appr.id)}
                                className="text-red-500 hover:text-red-700"
                                data-testid={`button-delete-approval-${appr.id}`}
                              >
                                <Trash2 className="w-3 h-3" />
                              </Button>
                            </div>
                          </div>
                          <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
                            <div>
                              <div className="text-muted-foreground">Advance Amount</div>
                              <div className={`font-semibold ${dimmed ? 'text-muted-foreground' : 'text-green-600 dark:text-green-400'}`}>
                                {formatCurrency(appr.advanceAmount)}
                              </div>
                            </div>
                            <div>
                              <div className="text-muted-foreground">Term</div>
                              <div className="font-medium">{appr.term || "N/A"}</div>
                            </div>
                            <div>
                              <div className="text-muted-foreground">Factor Rate</div>
                              <div className="font-medium">
                                {appr.factorRate ? `${appr.factorRate}x` : "N/A"}
                              </div>
                            </div>
                            <div>
                              <div className="text-muted-foreground">Payment Frequency</div>
                              <div className="font-medium capitalize">{appr.paymentFrequency || "N/A"}</div>
                            </div>
                            <div>
                              <div className="text-muted-foreground">Approval Date</div>
                              <div className="font-medium flex items-center gap-1">
                                <Calendar className="w-3 h-3" />
                                {appr.approvalDate ? formatDate(appr.approvalDate) : "N/A"}
                              </div>
                            </div>
                          </div>
                          {(appr.totalPayback || appr.netAfterFees) && (
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm mt-3 pt-3 border-t">
                              <div>
                                <div className="text-muted-foreground">Total Payback</div>
                                <div className="font-medium">{formatCurrency(appr.totalPayback)}</div>
                              </div>
                              <div>
                                <div className="text-muted-foreground">Net After Fees</div>
                                <div className="font-medium">{formatCurrency(appr.netAfterFees)}</div>
                              </div>
                            </div>
                          )}
                          {appr.notes && (
                            <div className="mt-3 pt-3 border-t text-sm">
                              <div className="text-muted-foreground mb-1">Notes</div>
                              <div className="whitespace-pre-wrap">{appr.notes}</div>
                            </div>
                          )}
                        </div>
                      );

                      return (
                        <div className="space-y-3">
                          {/* Recent approvals — shown normally */}
                          {recentApprovals.map(a => renderApproval(a, false))}

                          {/* Past approvals — collapsible, dimmed */}
                          {pastApprovals.length > 0 && (
                            <div className="border-t pt-2">
                              <button
                                onClick={() => setExpandedAdditionalApprovals(prev => {
                                  const next = new Set(prev);
                                  const key = decision.id + '-past';
                                  if (next.has(key)) next.delete(key);
                                  else next.add(key);
                                  return next;
                                })}
                                className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors py-1 w-full"
                                data-testid={`button-toggle-past-${decision.id}`}
                              >
                                {isPastExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                                <span className="font-medium">Past Approvals</span>
                                <Badge variant="outline" className="text-xs ml-1">{pastApprovals.length}</Badge>
                                <span className="text-xs">(before last funding)</span>
                              </button>
                              {isPastExpanded && (
                                <div className="space-y-3 mt-2">
                                  {pastApprovals.map(a => renderApproval(a, true))}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })()}

                    {(() => {
                      const uploads = getUploadsForEmail(decision.businessEmail || '');
                      if (uploads.length === 0) return null;
                      const isExpanded = expandedStatements.has(decision.id);
                      return (
                        <div className="pt-4 border-t">
                          <div className="flex flex-wrap gap-2 items-center mb-2">
                            <Badge variant="outline" className="flex items-center gap-1">
                              <FileText className="w-3 h-3" />
                              {uploads.length} Statement{uploads.length !== 1 ? 's' : ''}
                            </Badge>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleViewAllStatements(decision.businessEmail || '')}
                              data-testid={`button-view-all-${decision.id}`}
                            >
                              <Eye className="w-4 h-4 mr-1" />
                              View All
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleBulkDownloadStatements(decision.businessName || decision.businessEmail || '')}
                              data-testid={`button-download-all-${decision.id}`}
                            >
                              <FolderArchive className="w-4 h-4 mr-1" />
                              Download All
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => toggleStatements(decision.id)}
                              data-testid={`button-toggle-statements-${decision.id}`}
                            >
                              {isExpanded ? <ChevronUp className="w-4 h-4 mr-1" /> : <ChevronDown className="w-4 h-4 mr-1" />}
                              {isExpanded ? 'Hide' : 'Show'} Individual Files
                            </Button>
                          </div>
                          {isExpanded && (
                            <div className="space-y-2 mt-3">
                              {uploads.map((upload) => (
                                <div key={upload.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-3 bg-muted/50 rounded-lg">
                                  <div className="flex items-center gap-2 min-w-0">
                                    <FileText className="w-4 h-4 text-primary flex-shrink-0" />
                                    <span className="text-sm font-medium truncate">{upload.originalFileName}</span>
                                    <span className="text-xs text-muted-foreground flex-shrink-0">{formatFileSize(upload.fileSize)}</span>
                                  </div>
                                  <div className="flex gap-2 flex-shrink-0">
                                    <Button variant="outline" size="sm" onClick={() => handleViewStatement(upload.id)} data-testid={`button-view-statement-${upload.id}`}>
                                      <Eye className="w-4 h-4 mr-1" />
                                      View
                                    </Button>
                                    <Button variant="outline" size="sm" onClick={() => handleDownloadStatement(upload.id, upload.originalFileName)} data-testid={`button-download-statement-${upload.id}`}>
                                      <Download className="w-4 h-4 mr-1" />
                                      Download
                                    </Button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })()}

                    {decision.reviewedBy && (
                      <div className="text-xs text-muted-foreground">
                        Reviewed by: {decision.reviewedBy} | Last Approval: {formatDate(new Date(getMostRecentApprovalDate(decision)))}
                      </div>
                    )}
                  </div>
                </Card>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Edit/Add Approval Dialog */}
      <Dialog open={!!editingApproval} onOpenChange={(open) => !open && setEditingApproval(null)}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="w-5 h-5 text-primary" />
              {editingApproval?.approvalId ? 'Edit' : 'Add'} Approval: {editingApproval?.decision.businessName || editingApproval?.decision.businessEmail}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="edit-assignedRep">Rep #1</Label>
                <Select
                  value={editForm.assignedRep}
                  onValueChange={(value) => setEditForm(prev => ({ ...prev, assignedRep: value === '__none__' ? '' : value }))}
                >
                  <SelectTrigger id="edit-assignedRep" data-testid="select-edit-assigned-rep">
                    <SelectValue placeholder="Select rep (optional)" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">None</SelectItem>
                    {AGENTS.map(agent => (
                      <SelectItem key={agent.email} value={agent.name}>{agent.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="edit-assignedRep2">Rep #2</Label>
                <Select
                  value={editForm.assignedRep2}
                  onValueChange={(value) => setEditForm(prev => ({ ...prev, assignedRep2: value === '__none__' ? '' : value }))}
                >
                  <SelectTrigger id="edit-assignedRep2" data-testid="select-edit-assigned-rep2">
                    <SelectValue placeholder="Select rep (optional)" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">None</SelectItem>
                    {AGENTS.map(agent => (
                      <SelectItem key={agent.email} value={agent.name}>{agent.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Line of Credit — decision-level toggle */}
            <div className="border rounded-md p-3 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-sm font-medium">Line of Credit</Label>
                  <p className="text-xs text-muted-foreground">Merchant portal shows total credit line, drawn amount, and available balance</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={editForm.isLineOfCredit}
                  onClick={() => setEditForm(prev => ({ ...prev, isLineOfCredit: !prev.isLineOfCredit }))}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${editForm.isLineOfCredit ? 'bg-primary' : 'bg-muted-foreground/30'}`}
                  data-testid="toggle-line-of-credit"
                >
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${editForm.isLineOfCredit ? 'translate-x-6' : 'translate-x-1'}`} />
                </button>
              </div>
              {editForm.isLineOfCredit && (
                <div>
                  <Label htmlFor="edit-creditLineTotal">Total Credit Line Amount</Label>
                  <Input
                    id="edit-creditLineTotal"
                    type="number"
                    placeholder="750000"
                    value={editForm.creditLineTotal}
                    onChange={(e) => setEditForm(prev => ({ ...prev, creditLineTotal: e.target.value }))}
                    data-testid="input-credit-line-total"
                  />
                  <p className="text-xs text-muted-foreground mt-1">The total approved credit facility (e.g. $750,000 for EK Line). Individual draws are tracked separately.</p>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="edit-advanceAmount">Advance Amount</Label>
                <Input
                  id="edit-advanceAmount"
                  type="number"
                  placeholder="$50,000"
                  value={editForm.advanceAmount}
                  onChange={(e) => setEditForm(prev => ({ ...prev, advanceAmount: e.target.value }))}
                  data-testid="input-edit-advance-amount"
                />
              </div>
              <div>
                <Label htmlFor="edit-term">Term</Label>
                <Input
                  id="edit-term"
                  placeholder="6 months"
                  value={editForm.term}
                  onChange={(e) => setEditForm(prev => ({ ...prev, term: e.target.value }))}
                  data-testid="input-edit-term"
                />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <Label htmlFor="edit-paymentFrequency">Payment Frequency</Label>
                <Select
                  value={editForm.paymentFrequency}
                  onValueChange={(value) => setEditForm(prev => ({ ...prev, paymentFrequency: value }))}
                >
                  <SelectTrigger data-testid="select-edit-payment-frequency">
                    <SelectValue placeholder="Select frequency" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="weekly">Weekly</SelectItem>
                    <SelectItem value="monthly">Monthly</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="edit-numberOfPayments">
                  # of Payments <span className="text-muted-foreground font-normal">(optional)</span>
                </Label>
                <Input
                  id="edit-numberOfPayments"
                  type="number"
                  min="1"
                  step="1"
                  placeholder="e.g. 52"
                  value={editForm.numberOfPayments}
                  onChange={(e) => setEditForm(prev => ({ ...prev, numberOfPayments: e.target.value }))}
                  data-testid="input-edit-number-of-payments"
                />
                <p className="text-xs text-muted-foreground mt-1">Overrides the calculated count (e.g. 52 for 12-month weekly at 52 wk/yr)</p>
              </div>
              <div>
                <Label htmlFor="edit-lender">Lender</Label>
                <LenderAutocomplete
                  id="edit-lender"
                  placeholder="Search lender..."
                  value={editForm.lender}
                  onChange={(val) => setEditForm(prev => ({ ...prev, lender: val }))}
                  data-testid="input-edit-lender"
                />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <Label htmlFor="edit-factorRate">Factor Rate</Label>
                <Input
                  id="edit-factorRate"
                  type="number"
                  step="0.01"
                  placeholder="1.25"
                  value={editForm.factorRate}
                  onChange={(e) => setEditForm(prev => ({ ...prev, factorRate: e.target.value }))}
                  data-testid="input-edit-factor-rate"
                />
              </div>
              <div>
                <Label htmlFor="edit-buyRate">Buy Rate</Label>
                <Input
                  id="edit-buyRate"
                  type="number"
                  step="0.01"
                  placeholder="1.18"
                  value={editForm.buyRate}
                  onChange={(e) => setEditForm(prev => ({ ...prev, buyRate: e.target.value }))}
                  data-testid="input-edit-buy-rate"
                />
              </div>
              <div>
                <Label htmlFor="edit-sellRate">Sell Rate</Label>
                <Input
                  id="edit-sellRate"
                  type="number"
                  step="0.01"
                  placeholder="1.25"
                  value={editForm.sellRate}
                  onChange={(e) => setEditForm(prev => ({ ...prev, sellRate: e.target.value }))}
                  data-testid="input-edit-sell-rate"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="edit-maxUpsell">Max Upsell (%)</Label>
                <div className="relative">
                  <Input
                    id="edit-maxUpsell"
                    type="number"
                    step="1"
                    min="0"
                    max="100"
                    placeholder="20"
                    value={editForm.maxUpsell}
                    onChange={(e) => setEditForm(prev => ({ ...prev, maxUpsell: e.target.value }))}
                    data-testid="input-edit-max-upsell"
                    className="pr-8"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm pointer-events-none">%</span>
                </div>
              </div>
              <div>
                <Label htmlFor="edit-minimumDraw">Minimum Draw ($)</Label>
                <Input
                  id="edit-minimumDraw"
                  type="number"
                  min="0"
                  placeholder="25,000"
                  value={editForm.minimumDraw}
                  onChange={(e) => setEditForm(prev => ({ ...prev, minimumDraw: e.target.value }))}
                  data-testid="input-edit-minimum-draw"
                />
                <p className="text-xs text-muted-foreground mt-1">Slider floor on the offer page (TCG offers)</p>
              </div>
            </div>

            {/* Lender Display Name */}
            <div>
              <Label htmlFor="edit-lenderName">Lender Name (optional)</Label>
              <Input
                id="edit-lenderName"
                type="text"
                placeholder="e.g. PIRS Capital"
                value={editForm.lenderName}
                onChange={(e) => setEditForm(prev => ({ ...prev, lenderName: e.target.value }))}
                data-testid="input-edit-lender-name"
              />
              <p className="text-xs text-muted-foreground mt-1">If filled, this name appears on the merchant offer page instead of "Today Capital Group"</p>
            </div>

            {/* Early Payoff Toggle */}
            <div className="border rounded-md p-3 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="edit-earlyPayoffEnabled" className="text-sm font-medium">Early Payoff Table</Label>
                  <p className="text-xs text-muted-foreground">Show month-by-month pre-payment options on the offer page</p>
                </div>
                <button
                  type="button"
                  id="edit-earlyPayoffEnabled"
                  role="switch"
                  aria-checked={editForm.earlyPayoffEnabled}
                  onClick={() => setEditForm(prev => ({ ...prev, earlyPayoffEnabled: !prev.earlyPayoffEnabled }))}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${editForm.earlyPayoffEnabled ? 'bg-primary' : 'bg-muted-foreground/30'}`}
                  data-testid="toggle-early-payoff-enabled"
                >
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${editForm.earlyPayoffEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
                </button>
              </div>
              {editForm.earlyPayoffEnabled && (
                <div className="space-y-3 pt-1">
                  {/* Mode toggle */}
                  <div className="flex gap-1 p-1 bg-muted rounded-md w-fit">
                    <button
                      type="button"
                      onClick={() => setEditForm(prev => ({ ...prev, earlyPayoffMode: 'amounts' }))}
                      className={`px-3 py-1 text-xs font-medium rounded transition-colors ${editForm.earlyPayoffMode === 'amounts' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground'}`}
                      data-testid="button-payoff-mode-amounts"
                    >
                      Dollar Amounts
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditForm(prev => ({ ...prev, earlyPayoffMode: 'rates' }))}
                      className={`px-3 py-1 text-xs font-medium rounded transition-colors ${editForm.earlyPayoffMode === 'rates' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground'}`}
                      data-testid="button-payoff-mode-rates"
                    >
                      Factor Rates
                    </button>
                  </div>

                  {editForm.earlyPayoffMode === 'amounts' ? (
                    <div className="space-y-2">
                      <p className="text-xs text-muted-foreground">Enter the pre-payment amount for each month. Scales proportionally with the draw slider.</p>
                      {editForm.earlyPayoffAmounts.map((amt, idx) => (
                        <div key={idx} className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground w-16 shrink-0">Month {idx + 1}</span>
                          <div className="relative flex-1">
                            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm pointer-events-none">$</span>
                            <Input
                              type="number"
                              min="0"
                              step="100"
                              placeholder="e.g. 170800"
                              value={amt}
                              onChange={(e) => {
                                const next = [...editForm.earlyPayoffAmounts];
                                next[idx] = e.target.value;
                                setEditForm(prev => ({ ...prev, earlyPayoffAmounts: next }));
                              }}
                              className="pl-7"
                              data-testid={`input-early-payoff-month-${idx + 1}`}
                            />
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              const next = editForm.earlyPayoffAmounts.filter((_, i) => i !== idx);
                              setEditForm(prev => ({ ...prev, earlyPayoffAmounts: next }));
                            }}
                            className="text-muted-foreground hover:text-destructive transition-colors"
                            data-testid={`button-remove-payoff-month-${idx + 1}`}
                            aria-label="Remove month"
                          >
                            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={() => setEditForm(prev => ({ ...prev, earlyPayoffAmounts: [...prev.earlyPayoffAmounts, ''] }))}
                        className="text-xs text-primary hover:underline mt-1"
                        data-testid="button-add-payoff-month"
                      >
                        + Add Month
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <p className="text-xs text-muted-foreground">Enter the factor rate for each month. Dollar amount = draw × rate.</p>
                      {editForm.earlyPayoffRates.map((rate, idx) => (
                        <div key={idx} className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground w-16 shrink-0">Month {idx + 1}</span>
                          <div className="relative flex-1">
                            <Input
                              type="number"
                              min="1"
                              max="2"
                              step="0.01"
                              placeholder="e.g. 1.15"
                              value={rate}
                              onChange={(e) => {
                                const next = [...editForm.earlyPayoffRates];
                                next[idx] = e.target.value;
                                setEditForm(prev => ({ ...prev, earlyPayoffRates: next }));
                              }}
                              data-testid={`input-early-payoff-rate-${idx + 1}`}
                            />
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              const next = editForm.earlyPayoffRates.filter((_, i) => i !== idx);
                              setEditForm(prev => ({ ...prev, earlyPayoffRates: next }));
                            }}
                            className="text-muted-foreground hover:text-destructive transition-colors"
                            data-testid={`button-remove-payoff-rate-${idx + 1}`}
                            aria-label="Remove month"
                          >
                            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={() => setEditForm(prev => ({ ...prev, earlyPayoffRates: [...prev.earlyPayoffRates, ''] }))}
                        className="text-xs text-primary hover:underline mt-1"
                        data-testid="button-add-payoff-rate"
                      >
                        + Add Month
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="edit-approvalDate">Approval Date</Label>
                <Input
                  id="edit-approvalDate"
                  type="date"
                  value={editForm.approvalDate}
                  onChange={(e) => setEditForm(prev => ({ ...prev, approvalDate: e.target.value }))}
                  data-testid="input-edit-approval-date"
                />
              </div>
              <div>
                <Label htmlFor="edit-fundedDate">Funded Date</Label>
                <Input
                  id="edit-fundedDate"
                  type="date"
                  value={editForm.fundedDate}
                  onChange={(e) => setEditForm(prev => ({ ...prev, fundedDate: e.target.value }))}
                  data-testid="input-edit-funded-date"
                />
              </div>
            </div>
            <div>
              <Label htmlFor="edit-notes">Notes</Label>
              <Textarea
                id="edit-notes"
                placeholder="Additional notes..."
                rows={3}
                value={editForm.notes}
                onChange={(e) => setEditForm(prev => ({ ...prev, notes: e.target.value }))}
                data-testid="input-edit-notes"
              />
            </div>

            <div className="flex justify-end gap-2 pt-4">
              <Button
                variant="outline"
                onClick={() => setEditingApproval(null)}
                data-testid="button-cancel-edit"
              >
                <X className="w-4 h-4 mr-1" />
                Cancel
              </Button>
              <Button
                onClick={handleSaveEdit}
                disabled={saving}
                className="bg-green-600 hover:bg-green-700"
                data-testid="button-save-edit"
              >
                {saving ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Save className="w-4 h-4 mr-1" />
                    {editingApproval?.approvalId ? 'Update Approval' : 'Save Approval'}
                  </>
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      
      {/* CSV Import Dialog */}
      <Dialog open={showCsvUpload} onOpenChange={setShowCsvUpload}>
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="w-5 h-5" />
              Bulk Import Approvals from CSV
            </DialogTitle>
          </DialogHeader>
          
          <div className="space-y-4">
            <div className="bg-muted/50 p-4 rounded-md text-sm">
              <p className="font-medium mb-2">CSV Format:</p>
              <p className="text-muted-foreground text-xs mb-2">
                Your CSV should include these columns (in any order):
              </p>
              <ul className="text-xs text-muted-foreground list-disc list-inside space-y-1">
                <li><strong>Business Name</strong> (required)</li>
                <li><strong>Email</strong> (recommended - used to identify the business)</li>
                <li><strong>Phone</strong> or <strong>Phone Number</strong> (recommended - used to identify the business)</li>
                <li><strong>Overall Status</strong> (Approved / Declined Only)</li>
                <li><strong>Best Lender, Best Funding Amount, Best Factor Rate, Best Term, Best Payment Freq, Best Commission, Best Date</strong></li>
                <li><strong>Lender 2-5, Funding Amount 2-5, Factor Rate 2-5, Commission 2-5</strong> (for additional offers)</li>
                <li><strong>Declined Lender 1-3, Decline Reason 1-3</strong> (for decline info)</li>
              </ul>
              <p className="text-xs text-muted-foreground mt-2">
                Each row should include at least an <strong>Email</strong> or <strong>Phone</strong> so the business can be identified in the system.
              </p>
            </div>
            
            {/* File upload */}
            <div>
              <Label htmlFor="csv-file" className="mb-2 block">Upload CSV File</Label>
              <Input
                id="csv-file"
                type="file"
                accept=".csv,text/csv"
                onChange={handleCsvFileChange}
                data-testid="input-csv-file"
              />
            </div>
            
            {/* Or paste CSV */}
            <div>
              <Label htmlFor="csv-text" className="mb-2 block">Or Paste CSV Content</Label>
              <Textarea
                id="csv-text"
                placeholder="Paste your CSV data here..."
                rows={10}
                value={csvContent}
                onChange={(e) => setCsvContent(e.target.value)}
                className="font-mono text-xs"
                data-testid="input-csv-text"
              />
            </div>
            
            {/* Results */}
            {csvResults && (
              <div className={`p-4 rounded-md ${csvResults.errors > 0 ? 'bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800' : 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800'}`}>
                <p className="font-medium">
                  Import Results: {csvResults.imported} imported, {csvResults.errors} errors
                </p>
                {csvResults.results && csvResults.results.filter(r => r.status === 'error').length > 0 && (
                  <div className="mt-2 text-sm">
                    <p className="text-red-600 dark:text-red-400 font-medium">Errors:</p>
                    <ul className="list-disc list-inside text-xs mt-1">
                      {csvResults.results.filter(r => r.status === 'error').map((r, i) => (
                        <li key={i}>{r.businessName}: {r.error}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
            
            <div className="flex justify-end gap-2 pt-4">
              <Button
                variant="outline"
                onClick={() => setShowCsvUpload(false)}
                data-testid="button-cancel-csv"
              >
                Close
              </Button>
              <Button
                onClick={handleCsvUpload}
                disabled={csvUploading || !csvContent.trim()}
                className="bg-blue-600 hover:bg-blue-700"
                data-testid="button-import-csv"
              >
                {csvUploading ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Importing...
                  </>
                ) : (
                  <>
                    <Upload className="w-4 h-4 mr-1" />
                    Import CSV
                  </>
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Fund Deal Dialog */}
      <Dialog open={!!fundingDecision} onOpenChange={(open) => !open && setFundingDecision(null)}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Banknote className="w-5 h-5 text-emerald-600" />
              Fund Deal: {fundingDecision?.businessName || fundingDecision?.businessEmail}
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Review and update the approval details below before marking this deal as funded.
          </p>
          <div className="space-y-4 pt-2">
            <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 dark:bg-emerald-900/20 dark:border-emerald-800">
              <Label htmlFor="fund-fundedDate" className="text-emerald-700 dark:text-emerald-300 font-semibold">Funded Date</Label>
              <Input
                id="fund-fundedDate"
                type="date"
                value={fundForm.fundedDate}
                onChange={(e) => setFundForm(prev => ({ ...prev, fundedDate: e.target.value }))}
                className="mt-1"
                data-testid="input-fund-funded-date"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="fund-lender">Lender</Label>
                <LenderAutocomplete
                  id="fund-lender"
                  placeholder="Search lender..."
                  value={fundForm.lender}
                  onChange={(val) => setFundForm(prev => ({ ...prev, lender: val }))}
                  data-testid="input-fund-lender"
                />
              </div>
              <div>
                <Label htmlFor="fund-advanceAmount">Advance Amount</Label>
                <Input
                  id="fund-advanceAmount"
                  type="number"
                  placeholder="$50,000"
                  value={fundForm.advanceAmount}
                  onChange={(e) => setFundForm(prev => ({ ...prev, advanceAmount: e.target.value }))}
                  data-testid="input-fund-advance-amount"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="fund-term">Term</Label>
                <Input
                  id="fund-term"
                  placeholder="6 months"
                  value={fundForm.term}
                  onChange={(e) => setFundForm(prev => ({ ...prev, term: e.target.value }))}
                  data-testid="input-fund-term"
                />
              </div>
              <div>
                <Label htmlFor="fund-paymentFrequency">Payment Frequency</Label>
                <Select
                  value={fundForm.paymentFrequency}
                  onValueChange={(value) => setFundForm(prev => ({ ...prev, paymentFrequency: value }))}
                >
                  <SelectTrigger data-testid="select-fund-payment-frequency">
                    <SelectValue placeholder="Select frequency" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="weekly">Weekly</SelectItem>
                    <SelectItem value="monthly">Monthly</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <Label htmlFor="fund-factorRate">Factor Rate</Label>
                <Input
                  id="fund-factorRate"
                  type="number"
                  step="0.01"
                  placeholder="1.25"
                  value={fundForm.factorRate}
                  onChange={(e) => setFundForm(prev => ({ ...prev, factorRate: e.target.value }))}
                  data-testid="input-fund-factor-rate"
                />
              </div>
              <div>
                <Label htmlFor="fund-buyRate">Buy Rate</Label>
                <Input
                  id="fund-buyRate"
                  type="number"
                  step="0.01"
                  placeholder="1.18"
                  value={fundForm.buyRate}
                  onChange={(e) => setFundForm(prev => ({ ...prev, buyRate: e.target.value }))}
                  data-testid="input-fund-buy-rate"
                />
              </div>
              <div>
                <Label htmlFor="fund-sellRate">Sell Rate</Label>
                <Input
                  id="fund-sellRate"
                  type="number"
                  step="0.01"
                  placeholder="1.25"
                  value={fundForm.sellRate}
                  onChange={(e) => setFundForm(prev => ({ ...prev, sellRate: e.target.value }))}
                  data-testid="input-fund-sell-rate"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="fund-maxUpsell">Max Upsell</Label>
                <Input
                  id="fund-maxUpsell"
                  type="number"
                  placeholder="$75,000"
                  value={fundForm.maxUpsell}
                  onChange={(e) => setFundForm(prev => ({ ...prev, maxUpsell: e.target.value }))}
                  data-testid="input-fund-max-upsell"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="fund-totalPayback">Total Payback</Label>
                <Input
                  id="fund-totalPayback"
                  type="number"
                  placeholder="$62,500"
                  value={fundForm.totalPayback}
                  onChange={(e) => setFundForm(prev => ({ ...prev, totalPayback: e.target.value }))}
                  data-testid="input-fund-total-payback"
                />
              </div>
              <div>
                <Label htmlFor="fund-netAfterFees">Net After Fees</Label>
                <Input
                  id="fund-netAfterFees"
                  type="number"
                  placeholder="$48,500"
                  value={fundForm.netAfterFees}
                  onChange={(e) => setFundForm(prev => ({ ...prev, netAfterFees: e.target.value }))}
                  data-testid="input-fund-net-after-fees"
                />
              </div>
            </div>
            <div>
              <Label htmlFor="fund-approvalDate">Approval Date</Label>
              <Input
                id="fund-approvalDate"
                type="date"
                value={fundForm.approvalDate}
                onChange={(e) => setFundForm(prev => ({ ...prev, approvalDate: e.target.value }))}
                data-testid="input-fund-approval-date"
              />
            </div>
            <div>
              <Label htmlFor="fund-notes">Notes</Label>
              <Textarea
                id="fund-notes"
                placeholder="Additional notes..."
                rows={3}
                value={fundForm.notes}
                onChange={(e) => setFundForm(prev => ({ ...prev, notes: e.target.value }))}
                data-testid="input-fund-notes"
              />
            </div>

            {/* Previous Fundings — portal visibility */}
            {existingFundingsEdits.length > 0 && (
              <div className="border rounded-md p-3 space-y-2">
                <Label className="text-sm font-medium">Previous Fundings</Label>
                <p className="text-xs text-muted-foreground">Toggle which positions appear in the merchant portal.</p>
                {existingFundingsEdits.map((f, idx) => (
                  <div key={f.id || idx} className="flex items-center justify-between py-1.5 border-t first:border-t-0">
                    <div>
                      <div className="text-sm font-medium">{f.lender || 'Unknown lender'} — {f.advanceAmount ? `$${parseFloat(f.advanceAmount).toLocaleString()}` : 'N/A'}</div>
                      <div className="text-xs text-muted-foreground">{f.fundedDate ? new Date(f.fundedDate).toLocaleDateString() : ''}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">{f.hiddenFromPortal ? 'Hidden' : 'Visible'}</span>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={!f.hiddenFromPortal}
                        onClick={() => setExistingFundingsEdits(prev => prev.map((item, i) =>
                          i === idx ? { ...item, hiddenFromPortal: !item.hiddenFromPortal } : item
                        ))}
                        className={`relative inline-flex h-5 w-10 items-center rounded-full transition-colors focus:outline-none ${!f.hiddenFromPortal ? 'bg-primary' : 'bg-muted-foreground/30'}`}
                        data-testid={`toggle-funding-visibility-${idx}`}
                      >
                        <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${!f.hiddenFromPortal ? 'translate-x-5' : 'translate-x-1'}`} />
                      </button>
                    </div>
                  </div>
                ))}
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full mt-1"
                  onClick={handleSaveVisibilityOnly}
                  disabled={fundSaving}
                  data-testid="button-save-visibility-only"
                >
                  Save portal visibility changes
                </Button>
              </div>
            )}

            {/* Line of Credit */}
            <div className="border rounded-md p-3 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-sm font-medium">Line of Credit</Label>
                  <p className="text-xs text-muted-foreground">This draw is part of a revolving credit facility</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={fundForm.isLineOfCredit}
                  onClick={() => setFundForm(prev => ({ ...prev, isLineOfCredit: !prev.isLineOfCredit }))}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${fundForm.isLineOfCredit ? 'bg-primary' : 'bg-muted-foreground/30'}`}
                  data-testid="toggle-fund-line-of-credit"
                >
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${fundForm.isLineOfCredit ? 'translate-x-6' : 'translate-x-1'}`} />
                </button>
              </div>
              {fundForm.isLineOfCredit && (
                <div>
                  <Label htmlFor="fund-creditLineTotal">Total Credit Line Amount</Label>
                  <Input
                    id="fund-creditLineTotal"
                    type="number"
                    placeholder="750000"
                    value={fundForm.creditLineTotal}
                    onChange={(e) => setFundForm(prev => ({ ...prev, creditLineTotal: e.target.value }))}
                    data-testid="input-fund-credit-line-total"
                  />
                  <p className="text-xs text-muted-foreground mt-1">Total approved facility (e.g. $750,000). This draw of {fundForm.advanceAmount ? `$${parseInt(fundForm.advanceAmount).toLocaleString()}` : '...'} will be shown against it in the merchant portal.</p>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-4">
              <Button
                variant="outline"
                onClick={() => setFundingDecision(null)}
                data-testid="button-cancel-fund"
              >
                <X className="w-4 h-4 mr-1" />
                Cancel
              </Button>
              <Button
                onClick={handleSaveFund}
                disabled={fundSaving}
                className="bg-emerald-600 text-white"
                data-testid="button-confirm-fund"
              >
                {fundSaving ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Banknote className="w-4 h-4 mr-1" />
                    Mark as Funded
                  </>
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

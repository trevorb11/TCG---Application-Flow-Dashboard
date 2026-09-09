import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useLocation, Link } from "wouter";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { LenderAutocomplete } from "@/components/LenderAutocomplete";
import { StatusToggle } from "@/components/StatusToggle";
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
  Calendar,
  Save,
  X,
  Plus,
  Trash2,
  Landmark,
  Star,
  Eye,
  FileText,
  Download,
  FolderArchive,
  ChevronDown,
  ChevronUp,
  Banknote,
  Mail,
  UserCheck,
  Upload,
  ExternalLink,
  Users,
  TrendingUp,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
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
  totalPayback: string;
  netAfterFees: string;
  notes: string;
  approvalDate: string;
  isPrimary: boolean;
  createdAt: string;
}

interface FundedEntry {
  id: string;
  lender: string | null;
  advanceAmount: string | null;
  term: string | null;
  paymentFrequency: string | null;
  factorRate: string | null;
  buyRate: string | null;
  sellRate: string | null;
  maxUpsell: string | null;
  totalPayback: string | null;
  netAfterFees: string | null;
  notes: string | null;
  fundedDate: string;
  assignedRep: string | null;
  createdAt: string;
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
    timeZone: "UTC",
  });
}

export default function Funded() {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [accessDenied, setAccessDenied] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authRole, setAuthRole] = useState<string>("");
  const [authAgentName, setAuthAgentName] = useState<string>("");
  const [repFilter, setRepFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedAdditionalApprovals, setExpandedAdditionalApprovals] = useState<Set<string>>(new Set());
  const [expandedStatements, setExpandedStatements] = useState<Set<string>>(new Set());
  const [expandedFundings, setExpandedFundings] = useState<Set<string>>(new Set());
  const [deletingFundingEntry, setDeletingFundingEntry] = useState<{ decisionId: string; entryId: string } | null>(null);
  const [deletingFundingEntryLoading, setDeletingFundingEntryLoading] = useState(false);

  const [editingFunded, setEditingFunded] = useState<{
    decision: BusinessUnderwritingDecision;
    approvalId?: string;
  } | null>(null);
  const [editForm, setEditForm] = useState({
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
    fundedDate: '',
    assignedRep: '',
    repFollowers: [] as string[],
  });
  const [saving, setSaving] = useState(false);

  const [showAddFunded, setShowAddFunded] = useState(false);
  const [addForm, setAddForm] = useState({
    businessName: '',
    businessEmail: '',
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
    approvalDate: new Date().toISOString().split('T')[0],
    fundedDate: new Date().toISOString().split('T')[0],
    assignedRep: '',
  });
  const [addSaving, setAddSaving] = useState(false);

  const [showImportCsv, setShowImportCsv] = useState(false);
  const [csvContent, setCsvContent] = useState('');
  const [csvUploading, setCsvUploading] = useState(false);
  const [csvResults, setCsvResults] = useState<{ imported: number; errors: number; results?: { businessName: string; status: string; error?: string }[] } | null>(null);

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
    queryKey: ["/api/underwriting-decisions", "funded"],
    queryFn: async () => {
      // view=funded includes any record with funding entries, even if its status
      // is still "approved" (dual visibility — fundings always show here)
      const res = await fetch("/api/underwriting-decisions?view=funded", { credentials: "include" });
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

  const { data: agents } = useQuery<{ name: string; email: string }[]>({
    queryKey: ['/api/agents'],
    queryFn: async () => {
      const res = await fetch('/api/agents', { credentials: 'include' });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: isAuthenticated,
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

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/underwriting-decisions/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to delete');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/underwriting-decisions"] });
      toast({
        title: "Record deleted",
        description: "The funded record has been removed.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to delete the funded record.",
        variant: "destructive",
      });
    },
  });

  const [accessPortalLoadingId, setAccessPortalLoadingId] = useState<string | null>(null);

  const handleAccessPortal = async (decisionId: string) => {
    // Open blank window NOW (sync with user click) so browser doesn't block it as a popup
    const win = window.open('', '_blank');
    setAccessPortalLoadingId(decisionId);
    try {
      const res = await fetch('/api/merchant/admin-access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ decisionId }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (win) win.close();
        toast({ title: "Cannot access portal", description: data.error || 'Failed to generate preview', variant: "destructive" });
        return;
      }
      if (win) win.location.href = data.previewUrl;
    } catch {
      if (win) win.close();
      toast({ title: "Error", description: "Failed to open portal preview", variant: "destructive" });
    } finally {
      setAccessPortalLoadingId(null);
    }
  };

  const createPortalMutation = useMutation({
    mutationFn: async (decisionId: string) => {
      const res = await fetch('/api/merchant/create-portal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ decisionId }),
      });
      if (!res.ok) throw new Error('Failed to create portal');
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Portal ready",
        description: data.message || "Portal created. No invite sent yet — click 'Send Invite' when ready.",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/underwriting-decisions"] });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to create the portal.", variant: "destructive" });
    },
  });

  const resendInviteMutation = useMutation({
    mutationFn: async (decisionId: string) => {
      const res = await fetch('/api/merchant/resend-invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ decisionId }),
      });
      if (!res.ok) throw new Error('Failed to send invite');
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Portal invite sent",
        description: data.message || "The merchant portal invite has been sent.",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/underwriting-decisions"] });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to send the portal invite.",
        variant: "destructive",
      });
    },
  });

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
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message || "Failed to update.", variant: "destructive" });
    },
  });

  const addFundedMutation = useMutation({
    mutationFn: async (data: Record<string, any>) => {
      const res = await fetch('/api/underwriting-decisions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(errorData.error || `Server returned ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/underwriting-decisions"] });
    },
  });

  const generateApprovalId = () => `appr-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

  const openEditDialog = (decision: BusinessUnderwritingDecision, fundingId?: string) => {
    // Check additionalFundings first, then fall back to additionalApprovals for legacy data
    const fundings = getFundingsForDecision(decision);
    const entry = fundingId ? fundings.find(f => f.id === fundingId) : fundings[0];
    if (entry) {
      const fd = entry.fundedDate ? new Date(entry.fundedDate).toISOString().split('T')[0] : '';
      setEditForm({
        advanceAmount: entry.advanceAmount || '',
        term: entry.term || '',
        paymentFrequency: entry.paymentFrequency || 'weekly',
        factorRate: entry.factorRate || '',
        buyRate: (entry as any).buyRate || '',
        sellRate: (entry as any).sellRate || '',
        maxUpsell: entry.maxUpsell || '',
        totalPayback: entry.totalPayback || '',
        netAfterFees: entry.netAfterFees || '',
        lender: entry.lender || '',
        notes: entry.notes || '',
        approvalDate: fd,
        fundedDate: fd,
        assignedRep: entry.assignedRep || decision.assignedRep || '',
        repFollowers: (decision.repFollowers as string[]) || [],
      });
      setEditingFunded({ decision, approvalId: entry.id });
    } else {
      setEditForm({
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
        approvalDate: new Date().toISOString().split('T')[0],
        fundedDate: decision.fundedDate ? new Date(decision.fundedDate).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
        assignedRep: decision.assignedRep || '',
        repFollowers: (decision.repFollowers as string[]) || [],
      });
      setEditingFunded({ decision });
    }
  };

  const handleSaveEdit = async () => {
    if (!editingFunded) return;
    setSaving(true);
    try {
      const { decision, approvalId } = editingFunded;
      let fundings = getFundingsForDecision(decision);

      const updatedEntry: FundedEntry = {
        id: approvalId || generateApprovalId(),
        lender: editForm.lender || null,
        advanceAmount: editForm.advanceAmount || null,
        term: editForm.term || null,
        paymentFrequency: editForm.paymentFrequency || null,
        factorRate: editForm.factorRate || null,
        buyRate: editForm.buyRate || null,
        sellRate: editForm.sellRate || null,
        maxUpsell: editForm.maxUpsell || null,
        totalPayback: editForm.totalPayback || null,
        netAfterFees: editForm.netAfterFees || null,
        notes: editForm.notes || null,
        fundedDate: editForm.fundedDate
          ? new Date(editForm.fundedDate + 'T12:00:00').toISOString()
          : new Date().toISOString(),
        assignedRep: editForm.assignedRep || null,
        createdAt: approvalId
          ? (fundings.find(f => f.id === approvalId)?.createdAt || new Date().toISOString())
          : new Date().toISOString(),
      };

      if (approvalId) {
        // Replace existing entry
        const exists = fundings.find(f => f.id === approvalId);
        if (exists) {
          fundings = fundings.map(f => f.id === approvalId ? updatedEntry : f);
        } else {
          // Legacy id not found in additionalFundings; prepend as new
          fundings = [updatedEntry, ...fundings];
        }
      } else {
        fundings = [updatedEntry, ...fundings];
      }

      await updateMutation.mutateAsync({
        id: decision.id,
        updates: {
          additionalFundings: fundings,
          fundedDate: editForm.fundedDate,
          assignedRep: editForm.assignedRep || null,
          repFollowers: editForm.repFollowers,
        },
      });
      setEditingFunded(null);
      toast({ title: "Updated", description: "Funded deal details have been saved." });
    } finally {
      setSaving(false);
    }
  };


  const handleDeleteFundingEntry = async () => {
    if (!deletingFundingEntry) return;
    setDeletingFundingEntryLoading(true);
    try {
      const decision = allDecisions?.find(d => d.id === deletingFundingEntry.decisionId);
      if (!decision) return;
      const fundings = getFundingsForDecision(decision);
      const remaining = fundings.filter(f => f.id !== deletingFundingEntry.entryId);
      await updateMutation.mutateAsync({
        id: decision.id,
        updates: { additionalFundings: remaining },
      });
      setDeletingFundingEntry(null);
      toast({ title: "Deleted", description: "Funding entry removed." });
    } finally {
      setDeletingFundingEntryLoading(false);
    }
  };

  const handleAddFundedDeal = async () => {
    if (!addForm.businessEmail.trim()) {
      toast({ title: "Error", description: "Email is required.", variant: "destructive" });
      return;
    }
    setAddSaving(true);
    try {
      const fundedEntry: FundedEntry = {
        id: generateApprovalId(),
        lender: addForm.lender || null,
        advanceAmount: addForm.advanceAmount || null,
        term: addForm.term || null,
        paymentFrequency: addForm.paymentFrequency || null,
        factorRate: addForm.factorRate || null,
        buyRate: addForm.buyRate || null,
        sellRate: addForm.sellRate || null,
        maxUpsell: addForm.maxUpsell || null,
        totalPayback: addForm.totalPayback || null,
        netAfterFees: addForm.netAfterFees || null,
        notes: addForm.notes || null,
        fundedDate: addForm.fundedDate || new Date().toISOString(),
        assignedRep: addForm.assignedRep || null,
        createdAt: new Date().toISOString(),
      };

      await addFundedMutation.mutateAsync({
        businessName: addForm.businessName,
        businessEmail: addForm.businessEmail,
        status: 'funded',
        fundedDate: addForm.fundedDate,
        assignedRep: addForm.assignedRep || null,
        additionalFundings: [fundedEntry],
      });
      setShowAddFunded(false);
      setAddForm({
        businessName: '',
        businessEmail: '',
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
        approvalDate: new Date().toISOString().split('T')[0],
        fundedDate: new Date().toISOString().split('T')[0],
        assignedRep: '',
      });
      toast({ title: "Deal Added", description: `${addForm.businessName || addForm.businessEmail} has been added as funded.` });
    } catch (error: any) {
      toast({ title: "Error", description: error.message || "Failed to add funded deal.", variant: "destructive" });
    } finally {
      setAddSaving(false);
    }
  };

  const handleCsvImport = async () => {
    if (!csvContent.trim()) {
      toast({ title: "Error", description: "Please paste CSV content or upload a file.", variant: "destructive" });
      return;
    }
    setCsvUploading(true);
    setCsvResults(null);
    try {
      const res = await fetch('/api/underwriting-decisions/funded-bulk-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ csvData: csvContent }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to import');
      setCsvResults({ imported: data.imported, errors: data.errors, results: data.results });
      queryClient.invalidateQueries({ queryKey: ["/api/underwriting-decisions"] });
      if (data.errors === 0) {
        toast({ title: "Import Successful", description: `Imported ${data.imported} funded deals.` });
      } else {
        toast({ title: "Partial Success", description: `Imported ${data.imported} deals with ${data.errors} errors.` });
      }
    } catch (error: any) {
      toast({ title: "Import Failed", description: error.message, variant: "destructive" });
    } finally {
      setCsvUploading(false);
    }
  };

  const handleCsvFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      setCsvContent(event.target?.result as string || '');
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const downloadCsvTemplate = () => {
    const headers = ['Business Name', 'Business Email', 'Lender', 'Advance Amount', 'Term', 'Payment Frequency', 'Factor Rate', 'Max Upsell', 'Total Payback', 'Net After Fees', 'Notes', 'Approval Date', 'Funded Date', 'Assigned Rep'];
    const example = ['Acme Corp', 'acme@example.com', 'Lender Name', '50000', '6 months', 'weekly', '1.35', '', '67500', '48000', '', '2026-01-15', '2026-01-20', 'John Smith'];
    const csv = [headers.join(','), example.join(',')].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'funded-deals-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  // Helper: get all approvals for a decision (migration-aware)
  const getApprovalsForDecision = (decision: BusinessUnderwritingDecision): FullApprovalEntry[] => {
    const raw = decision.additionalApprovals as any[] | null;

    if (raw && raw.length > 0 && raw[0].isPrimary !== undefined) {
      return raw as FullApprovalEntry[];
    }

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
          isPrimary: false,
          createdAt: new Date().toISOString(),
        });
      });
    }

    return result;
  };

  // Helper: get all funded deal entries for a decision (newest first)
  const getFundingsForDecision = (decision: BusinessUnderwritingDecision): FundedEntry[] => {
    const raw = (decision as any).additionalFundings as any[] | null;
    if (raw && raw.length > 0) {
      // Already sorted newest-first by the storage layer; sort by fundedDate desc as safety
      return [...raw].sort((a, b) => {
        const da = a.fundedDate ? new Date(a.fundedDate).getTime() : new Date(a.createdAt || 0).getTime();
        const db2 = b.fundedDate ? new Date(b.fundedDate).getTime() : new Date(b.createdAt || 0).getTime();
        return db2 - da;
      }) as FundedEntry[];
    }
    // Migration fallback: build a single entry from the main record fields
    if (decision.advanceAmount || decision.lender || decision.fundedDate) {
      return [{
        id: 'legacy-' + decision.id,
        lender: decision.lender || null,
        advanceAmount: decision.advanceAmount?.toString() || null,
        term: decision.term || null,
        paymentFrequency: decision.paymentFrequency || null,
        factorRate: decision.factorRate?.toString() || null,
        buyRate: (decision as any).buyRate?.toString() || null,
        sellRate: (decision as any).sellRate?.toString() || null,
        maxUpsell: decision.maxUpsell?.toString() || null,
        totalPayback: decision.totalPayback?.toString() || null,
        netAfterFees: decision.netAfterFees?.toString() || null,
        notes: decision.notes || null,
        fundedDate: decision.fundedDate ? new Date(decision.fundedDate).toISOString() : new Date(decision.createdAt || Date.now()).toISOString(),
        assignedRep: decision.assignedRep || null,
        createdAt: decision.createdAt ? new Date(decision.createdAt).toISOString() : new Date().toISOString(),
      }];
    }
    return [];
  };

  const handleExportCsv = () => {
    const escape = (v: string | null | undefined) => {
      if (v == null) return '';
      const s = String(v);
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const headers = [
      'Business Name', 'Email', 'Assigned Rep', 'Funded Date',
      'Lender', 'Advance Amount', 'Term', 'Factor Rate',
      'Payment Frequency', 'Total Payback', 'Net After Fees', 'Max Upsell', 'Notes',
    ];

    const rows = filteredDecisions.map(d => {
      const fundings = getFundingsForDecision(d);
      const f = fundings[0];
      return [
        escape(d.businessName),
        escape(d.businessEmail),
        escape(d.assignedRep),
        escape(f?.fundedDate ? formatDate(f.fundedDate) : formatDate(d.fundedDate)),
        escape(f?.lender || d.lender),
        escape(f?.advanceAmount || d.advanceAmount?.toString()),
        escape(f?.term || d.term),
        escape(f?.factorRate || d.factorRate?.toString()),
        escape(f?.paymentFrequency || d.paymentFrequency),
        escape(f?.totalPayback || d.totalPayback?.toString()),
        escape(f?.netAfterFees || d.netAfterFees?.toString()),
        escape(f?.maxUpsell || d.maxUpsell?.toString()),
        escape(f?.notes || d.notes),
      ].join(',');
    });

    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `funded-deals-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: "Exported", description: `${filteredDecisions.length} funded deal${filteredDecisions.length !== 1 ? 's' : ''} exported to CSV.` });
  };

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

  // Dual visibility: include anything with funding entries, even if status
  // stayed "approved" (e.g. business funded one offer but has active approvals)
  const hasFundings = (d: BusinessUnderwritingDecision): boolean => {
    const f = (d as any).additionalFundings as any[] | null;
    return Array.isArray(f) && f.length > 0;
  };
  const fundedDecisions = (allDecisions || [])
    .filter(d => d.status === "funded" || hasFundings(d))
    .sort((a, b) => {
      const aDate = a.fundedDate ? new Date(a.fundedDate).getTime() : getMostRecentApprovalDate(a);
      const bDate = b.fundedDate ? new Date(b.fundedDate).getTime() : getMostRecentApprovalDate(b);
      return bDate - aDate;
    });

  // Filter by rep
  const repFilteredDecisions = repFilter === "all" ? fundedDecisions : fundedDecisions.filter(d => {
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
      (d.lender || "").toLowerCase().includes(q) ||
      (d.assignedRep || "").toLowerCase().includes(q)
    );
  });

  // Compute stats
  const stats = {
    totalFunded: fundedDecisions.length,
    totalFundings: fundedDecisions.reduce((sum, d) => sum + getFundingsForDecision(d).length, 0),
    totalAmount: fundedDecisions.reduce((sum, d) => {
      const approvals = getApprovalsForDecision(d);
      const primary = approvals.find(a => a.isPrimary) || approvals[0];
      return sum + (parseFloat(primary?.advanceAmount || "0") || 0);
    }, 0),
    totalApproved: statusCounts?.approved ?? 0,
  };

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

  const copyApprovalUrl = (slug: string) => {
    const url = `${window.location.origin}/approved/${slug}`;
    navigator.clipboard.writeText(url);
    toast({ title: "URL Copied", description: "Approval letter URL copied to clipboard" });
  };

  // Check for 403 errors
  useEffect(() => {
    if (decisionsError && (decisionsError as any).message?.includes("403")) {
      setAccessDenied(true);
    }
  }, [decisionsError]);

  if (!authChecked) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

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
                <h1 className="text-2xl font-bold" data-testid="heading-funded">
                  Funded Businesses
                </h1>
                <p className="text-muted-foreground">
                  Businesses that have been funded
                </p>
              </div>
            </div>
            <div className="flex gap-2 flex-wrap">
              <Button
                variant="outline"
                onClick={handleExportCsv}
                className="flex items-center gap-2"
                data-testid="button-export-csv"
                disabled={filteredDecisions.length === 0}
              >
                <Download className="w-4 h-4" />
                Export CSV
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setShowImportCsv(true);
                  setCsvContent('');
                  setCsvResults(null);
                }}
                className="flex items-center gap-2"
                data-testid="button-import-csv"
              >
                <Upload className="w-4 h-4" />
                Import CSV
              </Button>
              <Button
                onClick={() => {
                  setShowAddFunded(true);
                  setAddForm({
                    businessName: '',
                    businessEmail: '',
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
                    approvalDate: new Date().toISOString().split('T')[0],
                    fundedDate: new Date().toISOString().split('T')[0],
                    assignedRep: '',
                  });
                }}
                className="flex items-center gap-2"
                data-testid="button-add-funded"
              >
                <Plus className="w-4 h-4" />
                Add Funded Deal
              </Button>
              <Button
                variant="outline"
                onClick={() => setLocation("/approvals")}
                className="flex items-center gap-2"
                data-testid="button-view-approvals"
              >
                <CheckCircle2 className="w-4 h-4" />
                View Approvals ({stats.totalApproved})
              </Button>
            </div>
          </div>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-purple-100 rounded-lg dark:bg-purple-900">
                  <Banknote className="w-5 h-5 text-purple-600 dark:text-purple-400" />
                </div>
                <div>
                  <div className="text-2xl font-bold" data-testid="text-total-funded">
                    {stats.totalFunded}
                  </div>
                  <div className="text-sm text-muted-foreground">Funded Businesses</div>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-indigo-100 rounded-lg dark:bg-indigo-900">
                  <TrendingUp className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
                </div>
                <div>
                  <div className="text-2xl font-bold" data-testid="text-total-fundings">
                    {stats.totalFundings}
                  </div>
                  <div className="text-sm text-muted-foreground">Total Fundings</div>
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
                  <div className="text-2xl font-bold" data-testid="text-total-funded-amount">
                    {formatCurrency(stats.totalAmount)}
                  </div>
                  <div className="text-sm text-muted-foreground">Total Funded Amount</div>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-green-100 rounded-lg dark:bg-green-900">
                  <CheckCircle2 className="w-5 h-5 text-green-600 dark:text-green-400" />
                </div>
                <div>
                  <div className="text-2xl font-bold" data-testid="text-total-approvals">
                    {stats.totalApproved}
                  </div>
                  <div className="text-sm text-muted-foreground">Approved Businesses</div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
          <div className="flex gap-2">
            <Button variant={repFilter === "all" ? "default" : "outline"} size="sm" onClick={() => setRepFilter("all")}>
              All ({fundedDecisions.length})
            </Button>
            {authAgentName && (
              <Button variant={repFilter === "mine" ? "default" : "outline"} size="sm" onClick={() => setRepFilter("mine")}>
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

        {/* Funded List */}
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
          </div>
        ) : filteredDecisions.length === 0 ? (
          <Card className="p-12 text-center">
            <Banknote className="w-12 h-12 mx-auto mb-4 opacity-50 text-muted-foreground" />
            <p className="text-muted-foreground">
              {searchQuery ? "No funded businesses match your search" : "No funded businesses yet"}
            </p>
            <p className="text-sm text-muted-foreground mt-1">
              Mark businesses as funded from the dashboard once they have been funded
            </p>
          </Card>
        ) : (
          <div className="space-y-4">
            {filteredDecisions.map((decision) => {
              const fundings = getFundingsForDecision(decision);
              const newestFunding = fundings[0] || null;
              const olderFundings = fundings.slice(1);
              const isFundingsExpanded = expandedFundings.has(decision.id);

              const approvals = getApprovalsForDecision(decision);
              const sortedApprovals = [...approvals].sort((a, b) => (a.isPrimary ? -1 : b.isPrimary ? 1 : 0));
              const isAdditionalExpanded = expandedAdditionalApprovals.has(decision.id);

              const renderFundedEntry = (entry: FundedEntry, isNewest: boolean) => (
                <div
                  key={entry.id}
                  className={`p-4 rounded-lg border ${
                    isNewest
                      ? 'bg-emerald-50 border-emerald-200 dark:bg-emerald-900/20 dark:border-emerald-800'
                      : 'bg-muted/30 border-transparent'
                  }`}
                >
                  <div className="flex items-center justify-between gap-3 mb-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      {isNewest && <Star className="w-4 h-4 text-emerald-600 fill-emerald-500" />}
                      {isNewest && (
                        <Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300 text-xs">
                          Latest Funding
                        </Badge>
                      )}
                      <span className="font-semibold flex items-center gap-1">
                        <Landmark className="w-3 h-3 text-muted-foreground" />
                        {entry.lender || 'No lender'}
                      </span>
                      {entry.assignedRep && (
                        <Badge variant="outline" className="flex items-center gap-1 text-xs">
                          <UserCheck className="w-3 h-3" />
                          {entry.assignedRep}
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <div className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400 text-sm font-medium">
                        <Calendar className="w-3 h-3" />
                        {formatDate(entry.fundedDate)}
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => openEditDialog(decision, entry.id)}
                        data-testid={`button-edit-entry-${entry.id}`}
                        title="Edit this funding entry"
                      >
                        <Pencil className="w-3 h-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-destructive"
                        onClick={() => setDeletingFundingEntry({ decisionId: decision.id, entryId: entry.id })}
                        data-testid={`button-delete-entry-${entry.id}`}
                        title="Delete this funding entry"
                      >
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                    <div>
                      <div className="text-muted-foreground">Funded Amount</div>
                      <div className="font-semibold text-emerald-600 dark:text-emerald-400">
                        {formatCurrency(entry.advanceAmount)}
                      </div>
                      {(() => {
                        const primaryApproval = sortedApprovals.find(a => a.isPrimary);
                        const approvedRaw = primaryApproval?.advanceAmount != null ? parseFloat(primaryApproval.advanceAmount) : null;
                        const fundedRaw = entry.advanceAmount != null ? parseFloat(entry.advanceAmount) : null;
                        const approvedAmt = approvedRaw != null && !Number.isNaN(approvedRaw) ? approvedRaw : null;
                        const fundedAmt = fundedRaw != null && !Number.isNaN(fundedRaw) ? fundedRaw : null;
                        if (approvedAmt != null && fundedAmt != null && Math.abs(approvedAmt - fundedAmt) > 0.01) {
                          const isUnder = fundedAmt < approvedAmt;
                          return (
                            <div className="flex items-center gap-1 mt-1 flex-wrap" data-testid={`text-approved-vs-funded-${entry.id}`}>
                              <span className="text-xs text-muted-foreground line-through">{formatCurrency(approvedAmt)}</span>
                              <span className="text-xs text-muted-foreground">&rarr;</span>
                              <span className={`text-xs font-medium ${isUnder ? 'text-amber-600 dark:text-amber-400' : 'text-sky-600 dark:text-sky-400'}`}>
                                {isUnder ? 'under' : 'over'} by {formatCurrency(Math.abs(approvedAmt - fundedAmt))}
                              </span>
                            </div>
                          );
                        }
                        return null;
                      })()}
                    </div>
                    <div>
                      <div className="text-muted-foreground">Term</div>
                      <div className="font-medium">{entry.term || "N/A"}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Factor Rate</div>
                      <div className="font-medium">
                        {entry.factorRate ? `${entry.factorRate}x` : "N/A"}
                      </div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Payment Frequency</div>
                      <div className="font-medium capitalize">{entry.paymentFrequency || "N/A"}</div>
                    </div>
                  </div>
                  {(entry.totalPayback || entry.netAfterFees || entry.maxUpsell) && (
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm mt-3 pt-3 border-t">
                      {entry.totalPayback && (
                        <div>
                          <div className="text-muted-foreground">Total Payback</div>
                          <div className="font-medium">{formatCurrency(entry.totalPayback)}</div>
                        </div>
                      )}
                      {entry.netAfterFees && (
                        <div>
                          <div className="text-muted-foreground">Net After Fees</div>
                          <div className="font-medium">{formatCurrency(entry.netAfterFees)}</div>
                        </div>
                      )}
                      {entry.maxUpsell && (
                        <div>
                          <div className="text-muted-foreground">Max Upsell</div>
                          <div className="font-medium">{entry.maxUpsell}%</div>
                        </div>
                      )}
                    </div>
                  )}
                  {entry.notes && (
                    <div className="mt-3 pt-3 border-t text-sm">
                      <div className="text-muted-foreground mb-1">Notes</div>
                      <div className="whitespace-pre-wrap">{entry.notes}</div>
                    </div>
                  )}
                </div>
              );

              const renderApprovalEntry = (appr: FullApprovalEntry) => (
                <div key={appr.id} className="p-3 rounded-lg bg-muted/30 border border-transparent text-sm">
                  <div className="flex items-center gap-2 mb-2">
                    {appr.isPrimary && <Star className="w-3 h-3 text-yellow-500 fill-yellow-500" />}
                    <span className="font-medium flex items-center gap-1">
                      <Landmark className="w-3 h-3 text-muted-foreground" />
                      {appr.lender || 'No lender'}
                    </span>
                    {appr.isPrimary && (
                      <Badge className="bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300 text-xs">Primary</Badge>
                    )}
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <div><div className="text-muted-foreground text-xs">Amount</div><div className="font-medium">{formatCurrency(appr.advanceAmount)}</div></div>
                    <div><div className="text-muted-foreground text-xs">Term</div><div className="font-medium">{appr.term || "N/A"}</div></div>
                    <div><div className="text-muted-foreground text-xs">Factor Rate</div><div className="font-medium">{appr.factorRate ? `${appr.factorRate}x` : "N/A"}</div></div>
                    <div><div className="text-muted-foreground text-xs">Approval Date</div><div className="font-medium flex items-center gap-1"><Calendar className="w-3 h-3" />{formatDate(appr.approvalDate)}</div></div>
                  </div>
                </div>
              );

              return (
                <Card key={decision.id} className="p-6 hover-elevate" data-testid={`card-funded-${decision.id}`}>
                  <div className="flex flex-col gap-4">
                    {/* Business header */}
                    <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
                      <div className="flex items-center gap-3 flex-wrap">
                        <h3 className="font-semibold text-lg flex items-center gap-2">
                          <Building2 className="w-5 h-5 text-primary" />
                          {decision.businessName || decision.businessEmail}
                        </h3>
                        <Badge className="bg-purple-600 hover:bg-purple-700 flex items-center gap-1">
                          <Banknote className="w-3 h-3" />
                          Funded
                        </Badge>
                        <Badge variant="secondary" className="text-xs">
                          {fundings.length} {fundings.length === 1 ? 'Funding' : 'Fundings'}
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
                      </div>
                      <div className="flex gap-2 flex-wrap">
                        {(decision.businessEmail || (decision as any).merchantEmail) && (
                          <Link href={`/merchant-profile/${encodeURIComponent(decision.businessEmail || (decision as any).merchantEmail)}`}>
                            <Button variant="outline" size="sm" className="text-xs" data-testid={`button-profile-${decision.id}`}>
                              <Building2 className="w-3 h-3 mr-1" />
                              Profile
                            </Button>
                          </Link>
                        )}
                        <StatusToggle decision={decision} currentStatus="funded" />
                        {(() => {
                          const hasPortalAccess = !!(decision as any).merchantPasswordHash || !!(decision as any).merchantPortalToken;
                          if (!hasPortalAccess) {
                            return (
                              <Button
                                variant="default"
                                size="sm"
                                onClick={() => createPortalMutation.mutate(decision.id)}
                                disabled={createPortalMutation.isPending}
                                className="text-xs"
                                data-testid={`button-setup-portal-${decision.id}`}
                              >
                                <UserCheck className="w-3 h-3 mr-1" />
                                {createPortalMutation.isPending ? "Setting up..." : "Setup Portal"}
                              </Button>
                            );
                          }
                          return (
                            <>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handleAccessPortal(decision.id)}
                                disabled={accessPortalLoadingId === decision.id}
                                className="text-xs"
                                data-testid={`button-access-portal-${decision.id}`}
                              >
                                <ExternalLink className="w-3 h-3 mr-1" />
                                {accessPortalLoadingId === decision.id ? "Opening..." : "Access Portal"}
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => resendInviteMutation.mutate(decision.id)}
                                disabled={resendInviteMutation.isPending}
                                className="text-xs"
                                data-testid={`button-send-invite-${decision.id}`}
                              >
                                <Mail className="w-3 h-3 mr-1" />
                                {resendInviteMutation.isPending ? "Sending..." : "Send Portal Invite"}
                              </Button>
                            </>
                          );
                        })()}
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-muted-foreground"
                              data-testid={`button-delete-funded-${decision.id}`}
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Delete Funded Record</AlertDialogTitle>
                              <AlertDialogDescription>
                                Are you sure you want to delete the funded record for{" "}
                                <strong>{decision.businessName || decision.businessEmail}</strong>?
                                This action cannot be undone.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel data-testid="button-cancel-delete">Cancel</AlertDialogCancel>
                              <AlertDialogAction
                                onClick={() => deleteMutation.mutate(decision.id)}
                                className="bg-destructive text-destructive-foreground"
                                data-testid="button-confirm-delete"
                              >
                                {deleteMutation.isPending ? (
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                ) : (
                                  "Delete"
                                )}
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    </div>

                    <div className="flex items-center gap-3 text-sm text-muted-foreground flex-wrap">
                      <span>{decision.businessEmail}</span>
                      {decision.assignedRep && (
                        <Badge variant="outline" className="flex items-center gap-1 text-xs">
                          <UserCheck className="w-3 h-3" />
                          {decision.assignedRep}
                        </Badge>
                      )}
                    </div>

                    {/* Funded Deal Entries — newest first, older ones in dropdown */}
                    <div className="space-y-3">
                      {newestFunding && renderFundedEntry(newestFunding, true)}
                      {olderFundings.length > 0 && (
                        <div>
                          <button
                            onClick={() => setExpandedFundings(prev => {
                              const next = new Set(prev);
                              if (next.has(decision.id)) next.delete(decision.id);
                              else next.add(decision.id);
                              return next;
                            })}
                            className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors py-2"
                            data-testid={`button-toggle-fundings-${decision.id}`}
                          >
                            {isFundingsExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                            {isFundingsExpanded ? 'Hide' : 'View'} {olderFundings.length} Previous {olderFundings.length === 1 ? 'Funding' : 'Fundings'}
                          </button>
                          {isFundingsExpanded && (
                            <div className="space-y-3">
                              {olderFundings.map(e => renderFundedEntry(e, false))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Approval Packages (if any — shown for businesses that had a prior approval) */}
                    {sortedApprovals.length > 0 && (
                      <div className="pt-3 border-t">
                        <button
                          onClick={() => setExpandedAdditionalApprovals(prev => {
                            const next = new Set(prev);
                            if (next.has(decision.id)) next.delete(decision.id);
                            else next.add(decision.id);
                            return next;
                          })}
                          className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors py-1"
                          data-testid={`button-toggle-approvals-${decision.id}`}
                        >
                          {isAdditionalExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                          {isAdditionalExpanded ? 'Hide' : 'View'} {sortedApprovals.length} Approval {sortedApprovals.length === 1 ? 'Package' : 'Packages'}
                        </button>
                        {isAdditionalExpanded && (
                          <div className="space-y-2 mt-2">
                            {sortedApprovals.map(renderApprovalEntry)}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Bank Statements */}
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
                        Reviewed by: {decision.reviewedBy} | Updated: {formatDate(decision.updatedAt)}
                      </div>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Edit Funded Deal Dialog */}
      <Dialog open={!!editingFunded} onOpenChange={(open) => !open && setEditingFunded(null)}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="w-5 h-5 text-primary" />
              Edit Funded Deal: {editingFunded?.decision.businessName || editingFunded?.decision.businessEmail}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-4">
            <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 dark:bg-emerald-900/20 dark:border-emerald-800">
              <Label htmlFor="edit-fundedDate" className="text-emerald-700 dark:text-emerald-300 font-semibold">Funded Date</Label>
              <Input
                id="edit-fundedDate"
                type="date"
                value={editForm.fundedDate}
                onChange={(e) => setEditForm(prev => ({ ...prev, fundedDate: e.target.value }))}
                data-testid="input-edit-funded-date"
              />
            </div>
            <div>
              <Label htmlFor="edit-assignedRep">Assigned Rep</Label>
              <Select
                value={editForm.assignedRep}
                onValueChange={(value) => setEditForm(prev => ({ ...prev, assignedRep: value === '__none__' ? '' : value }))}
              >
                <SelectTrigger data-testid="select-edit-assigned-rep">
                  <SelectValue placeholder="Select a rep" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">None</SelectItem>
                  {(agents || []).map(agent => (
                    <SelectItem key={agent.email} value={agent.name}>{agent.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="flex items-center gap-1.5 mb-2"><Users className="w-3.5 h-3.5" />Followers</Label>
              <p className="text-xs text-muted-foreground mb-2">Reps who can see this file in addition to the assigned rep.</p>
              <div className="flex flex-col gap-1.5 max-h-36 overflow-y-auto border rounded-md p-2">
                {(agents || []).filter(a => a.name !== editForm.assignedRep).map(agent => {
                  const isFollower = editForm.repFollowers.includes(agent.name);
                  return (
                    <label key={agent.email} className="flex items-center gap-2 cursor-pointer text-sm py-0.5">
                      <input
                        type="checkbox"
                        checked={isFollower}
                        onChange={(e) => {
                          const followers = e.target.checked
                            ? [...editForm.repFollowers, agent.name]
                            : editForm.repFollowers.filter(f => f !== agent.name);
                          setEditForm(prev => ({ ...prev, repFollowers: followers }));
                        }}
                        className="w-3.5 h-3.5"
                        data-testid={`checkbox-follower-${agent.name.replace(/\s+/g, '-').toLowerCase()}`}
                      />
                      {agent.name}
                    </label>
                  );
                })}
                {(agents || []).filter(a => a.name !== editForm.assignedRep).length === 0 && (
                  <p className="text-xs text-muted-foreground py-1">No other reps available.</p>
                )}
              </div>
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
            <div className="grid grid-cols-2 gap-4">
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
                <Label htmlFor="edit-maxUpsell">Max Upsell</Label>
                <Input
                  id="edit-maxUpsell"
                  type="number"
                  placeholder="$75,000"
                  value={editForm.maxUpsell}
                  onChange={(e) => setEditForm(prev => ({ ...prev, maxUpsell: e.target.value }))}
                  data-testid="input-edit-max-upsell"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="edit-netAfterFees">Net After Fees</Label>
                <Input
                  id="edit-netAfterFees"
                  type="number"
                  placeholder="$48,500"
                  value={editForm.netAfterFees}
                  onChange={(e) => setEditForm(prev => ({ ...prev, netAfterFees: e.target.value }))}
                  data-testid="input-edit-net-after-fees"
                />
              </div>
              <div>
                <Label htmlFor="edit-totalPayback">Total Payback</Label>
                <Input
                  id="edit-totalPayback"
                  type="number"
                  placeholder="$62,500"
                  value={editForm.totalPayback}
                  onChange={(e) => setEditForm(prev => ({ ...prev, totalPayback: e.target.value }))}
                  data-testid="input-edit-total-payback"
                />
              </div>
            </div>
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
                onClick={() => setEditingFunded(null)}
                data-testid="button-cancel-edit"
              >
                <X className="w-4 h-4 mr-1" />
                Cancel
              </Button>
              <Button
                onClick={handleSaveEdit}
                disabled={saving}
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
                    Save Changes
                  </>
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* CSV Import Dialog */}
      <Dialog open={showImportCsv} onOpenChange={(open) => { setShowImportCsv(open); if (!open) { setCsvContent(''); setCsvResults(null); } }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Upload className="w-5 h-5 text-primary" />
              Import Funded Deals from CSV
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="rounded-md bg-muted p-4 text-sm space-y-1">
              <p className="font-medium">Required columns:</p>
              <p className="text-muted-foreground">Business Name, Business Email</p>
              <p className="font-medium mt-2">Optional columns:</p>
              <p className="text-muted-foreground">Lender, Advance Amount, Term, Payment Frequency, Factor Rate, Max Upsell, Total Payback, Net After Fees, Notes, Approval Date, Funded Date, Assigned Rep</p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={downloadCsvTemplate} data-testid="button-download-template">
                <Download className="w-4 h-4 mr-2" />
                Download Template
              </Button>
              <label htmlFor="csv-file-upload-funded">
                <Button variant="outline" size="sm" asChild data-testid="button-upload-csv-file">
                  <span>
                    <FileText className="w-4 h-4 mr-2" />
                    Upload CSV File
                  </span>
                </Button>
              </label>
              <input
                id="csv-file-upload-funded"
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={handleCsvFileChange}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="csv-content-funded">Or paste CSV content</Label>
              <Textarea
                id="csv-content-funded"
                value={csvContent}
                onChange={(e) => setCsvContent(e.target.value)}
                placeholder="Business Name,Business Email,Lender,Advance Amount,..."
                className="font-mono text-xs min-h-[160px]"
                data-testid="textarea-csv-content"
              />
            </div>
            {csvResults && (
              <div className={`rounded-md p-4 text-sm ${csvResults.errors === 0 ? 'bg-green-50 dark:bg-green-900/20' : 'bg-yellow-50 dark:bg-yellow-900/20'}`}>
                <p className="font-medium mb-2">
                  Import complete: {csvResults.imported} imported, {csvResults.errors} errors
                </p>
                {csvResults.results && csvResults.results.filter(r => r.status === 'error').length > 0 && (
                  <ul className="space-y-1 text-muted-foreground">
                    {csvResults.results.filter(r => r.status === 'error').map((r, idx) => (
                      <li key={idx} className="text-red-600 dark:text-red-400">
                        {r.businessName}: {r.error}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => { setShowImportCsv(false); setCsvContent(''); setCsvResults(null); }} data-testid="button-cancel-import">
                Cancel
              </Button>
              <Button onClick={handleCsvImport} disabled={csvUploading || !csvContent.trim()} data-testid="button-run-import">
                {csvUploading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Upload className="w-4 h-4 mr-2" />}
                {csvUploading ? 'Importing...' : 'Import Deals'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Add Funded Deal Dialog */}
      <Dialog open={showAddFunded} onOpenChange={setShowAddFunded}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Plus className="w-5 h-5 text-primary" />
              Add Funded Deal
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Manually add a business that has been funded.
          </p>
          <div className="space-y-4 pt-2">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="add-businessName">Business Name</Label>
                <Input
                  id="add-businessName"
                  placeholder="Business Name"
                  value={addForm.businessName}
                  onChange={(e) => setAddForm(prev => ({ ...prev, businessName: e.target.value }))}
                  data-testid="input-add-business-name"
                />
              </div>
              <div>
                <Label htmlFor="add-businessEmail">Email *</Label>
                <Input
                  id="add-businessEmail"
                  type="email"
                  placeholder="business@email.com"
                  value={addForm.businessEmail}
                  onChange={(e) => setAddForm(prev => ({ ...prev, businessEmail: e.target.value }))}
                  data-testid="input-add-business-email"
                />
              </div>
            </div>
            <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 dark:bg-emerald-900/20 dark:border-emerald-800">
              <Label htmlFor="add-fundedDate" className="text-emerald-700 dark:text-emerald-300 font-semibold">Funded Date</Label>
              <Input
                id="add-fundedDate"
                type="date"
                value={addForm.fundedDate}
                onChange={(e) => setAddForm(prev => ({ ...prev, fundedDate: e.target.value }))}
                data-testid="input-add-funded-date"
              />
            </div>
            <div>
              <Label htmlFor="add-assignedRep">Assigned Rep</Label>
              <Select
                value={addForm.assignedRep}
                onValueChange={(value) => setAddForm(prev => ({ ...prev, assignedRep: value === '__none__' ? '' : value }))}
              >
                <SelectTrigger data-testid="select-add-assigned-rep">
                  <SelectValue placeholder="Select a rep" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">None</SelectItem>
                  {(agents || []).map(agent => (
                    <SelectItem key={agent.email} value={agent.name}>{agent.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="add-advanceAmount">Advance Amount</Label>
                <Input
                  id="add-advanceAmount"
                  type="number"
                  placeholder="$50,000"
                  value={addForm.advanceAmount}
                  onChange={(e) => setAddForm(prev => ({ ...prev, advanceAmount: e.target.value }))}
                  data-testid="input-add-advance-amount"
                />
              </div>
              <div>
                <Label htmlFor="add-term">Term</Label>
                <Input
                  id="add-term"
                  placeholder="6 months"
                  value={addForm.term}
                  onChange={(e) => setAddForm(prev => ({ ...prev, term: e.target.value }))}
                  data-testid="input-add-term"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="add-paymentFrequency">Payment Frequency</Label>
                <Select
                  value={addForm.paymentFrequency}
                  onValueChange={(value) => setAddForm(prev => ({ ...prev, paymentFrequency: value }))}
                >
                  <SelectTrigger data-testid="select-add-payment-frequency">
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
                <Label htmlFor="add-lender">Lender</Label>
                <LenderAutocomplete
                  id="add-lender"
                  placeholder="Search lender..."
                  value={addForm.lender}
                  onChange={(val) => setAddForm(prev => ({ ...prev, lender: val }))}
                  data-testid="input-add-lender"
                />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <Label htmlFor="add-factorRate">Factor Rate</Label>
                <Input
                  id="add-factorRate"
                  type="number"
                  step="0.01"
                  placeholder="1.25"
                  value={addForm.factorRate}
                  onChange={(e) => setAddForm(prev => ({ ...prev, factorRate: e.target.value }))}
                  data-testid="input-add-factor-rate"
                />
              </div>
              <div>
                <Label htmlFor="add-buyRate">Buy Rate</Label>
                <Input
                  id="add-buyRate"
                  type="number"
                  step="0.01"
                  placeholder="1.18"
                  value={addForm.buyRate}
                  onChange={(e) => setAddForm(prev => ({ ...prev, buyRate: e.target.value }))}
                  data-testid="input-add-buy-rate"
                />
              </div>
              <div>
                <Label htmlFor="add-sellRate">Sell Rate</Label>
                <Input
                  id="add-sellRate"
                  type="number"
                  step="0.01"
                  placeholder="1.25"
                  value={addForm.sellRate}
                  onChange={(e) => setAddForm(prev => ({ ...prev, sellRate: e.target.value }))}
                  data-testid="input-add-sell-rate"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="add-maxUpsell">Max Upsell</Label>
                <Input
                  id="add-maxUpsell"
                  type="number"
                  placeholder="$75,000"
                  value={addForm.maxUpsell}
                  onChange={(e) => setAddForm(prev => ({ ...prev, maxUpsell: e.target.value }))}
                  data-testid="input-add-max-upsell"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="add-netAfterFees">Net After Fees</Label>
                <Input
                  id="add-netAfterFees"
                  type="number"
                  placeholder="$48,500"
                  value={addForm.netAfterFees}
                  onChange={(e) => setAddForm(prev => ({ ...prev, netAfterFees: e.target.value }))}
                  data-testid="input-add-net-after-fees"
                />
              </div>
              <div>
                <Label htmlFor="add-totalPayback">Total Payback</Label>
                <Input
                  id="add-totalPayback"
                  type="number"
                  placeholder="$62,500"
                  value={addForm.totalPayback}
                  onChange={(e) => setAddForm(prev => ({ ...prev, totalPayback: e.target.value }))}
                  data-testid="input-add-total-payback"
                />
              </div>
            </div>
            <div>
              <Label htmlFor="add-approvalDate">Approval Date</Label>
              <Input
                id="add-approvalDate"
                type="date"
                value={addForm.approvalDate}
                onChange={(e) => setAddForm(prev => ({ ...prev, approvalDate: e.target.value }))}
                data-testid="input-add-approval-date"
              />
            </div>
            <div>
              <Label htmlFor="add-notes">Notes</Label>
              <Textarea
                id="add-notes"
                placeholder="Additional notes..."
                rows={3}
                value={addForm.notes}
                onChange={(e) => setAddForm(prev => ({ ...prev, notes: e.target.value }))}
                data-testid="input-add-notes"
              />
            </div>
            <div className="flex justify-end gap-2 pt-4">
              <Button
                variant="outline"
                onClick={() => setShowAddFunded(false)}
                data-testid="button-cancel-add"
              >
                <X className="w-4 h-4 mr-1" />
                Cancel
              </Button>
              <Button
                onClick={handleAddFundedDeal}
                disabled={addSaving || !addForm.businessEmail.trim()}
                data-testid="button-save-add"
              >
                {addSaving ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Adding...
                  </>
                ) : (
                  <>
                    <Banknote className="w-4 h-4 mr-1" />
                    Add Funded Deal
                  </>
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete individual funding entry confirmation */}
      <AlertDialog open={!!deletingFundingEntry} onOpenChange={(open) => !open && setDeletingFundingEntry(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Funding Entry</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to remove this funding entry? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-entry">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteFundingEntry}
              className="bg-destructive text-destructive-foreground"
              data-testid="button-confirm-delete-entry"
            >
              {deletingFundingEntryLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                "Delete"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

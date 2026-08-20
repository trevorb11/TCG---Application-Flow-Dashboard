import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { type LoanApplication, type BankStatementUpload, type BusinessUnderwritingDecision } from "@shared/schema";
import { queryClient, getQueryFn } from "@/lib/queryClient";
import { BankStatementSnapshot } from "@/components/BankStatementSnapshot";
import { CallHistory, MerchantNotes } from "@/components/MerchantProfileEnhancements";
import { useToast } from "@/hooks/use-toast";
import { usePlaidLink } from "react-plaid-link";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Search, ExternalLink, Filter, CheckCircle2, Clock, Lock, LogOut, User, Shield, Landmark, FileText, X, Loader2, TrendingUp, TrendingDown, Minus, Building2, DollarSign, Calendar as CalendarIcon, Download, Upload, Pencil, Save, Bot, AlertTriangle, Star, FolderArchive, ChevronDown, ChevronUp, ChevronRight, Sparkles, AlertCircle, ThumbsUp, ThumbsDown, Target, Mail, Eye, Check, FileEdit, Link2, Copy, Plus, Trash2, Banknote, Menu, MessageSquare, BarChart3, Trophy, Phone, Send, Globe } from "lucide-react";
import { Link } from "wouter";
import { LoginForm } from "@/components/auth/LoginForm";
import { BotAttemptsTab } from "@/components/dashboard/BotAttemptsTab";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, DropdownMenuLabel } from "@/components/ui/dropdown-menu";
import { Checkbox } from "@/components/ui/checkbox";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";

interface AuthState {
  isAuthenticated: boolean;
  role?: 'admin' | 'agent' | 'partner' | 'underwriting' | 'user';
  agentEmail?: string;
  agentName?: string;
}

// LoginForm imported from @/components/auth/LoginForm

interface BankStatement {
  accounts: Array<{
    accountId: string;
    name: string;
    type: string;
    subtype: string;
    currentBalance: number;
    availableBalance: number | null;
  }>;
  transactions: Array<{
    transactionId: string;
    date: string;
    name: string;
    amount: number;
    category: string[];
    pending: boolean;
  }>;
  institutionName: string;
  dateRange: {
    startDate: string;
    endDate: string;
  };
}

interface BankConnection {
  id: string;
  businessName: string;
  email: string;
  institutionName: string;
  monthlyRevenue: string;
  avgBalance: string;
  negativeDays: number;
  analysisResult: {
    sba: { status: string; reason: string };
    loc: { status: string; reason: string };
    mca: { status: string; reason: string };
  };
  plaidItemId: string;
  createdAt: string;
}

interface ChirpConnection {
  id: string;
  fullName: string;
  email: string;
  phone: string;
  businessName: string;
  requestedAmount: string;
  chirpRequestCode: string;
  createdAt: string;
}

interface BotAttempt {
  id: string;
  email: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  honeypotValue: string | null;
  formType: string | null;
  additionalData: any;
  createdAt: string;
}

function StatementsModal({ 
  applicationId, 
  isOpen,
  onClose 
}: { 
  applicationId: string;
  isOpen: boolean;
  onClose: () => void;
}) {
  const { data: statements, isLoading, error, refetch } = useQuery<BankStatement>({
    queryKey: ['/api/plaid/statements', applicationId],
    queryFn: async () => {
      const res = await fetch(`/api/plaid/statements/${applicationId}?months=3`, {
        credentials: 'include',
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to fetch statements');
      }
      return res.json();
    },
    enabled: isOpen && !!applicationId,
    retry: 1,
  });

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-hidden flex flex-col" data-testid="dialog-statements">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Landmark className="w-5 h-5" />
            Bank Statements
          </DialogTitle>
          {statements && (
            <p className="text-sm text-muted-foreground">
              {statements.institutionName} | {statements.dateRange.startDate} to {statements.dateRange.endDate}
            </p>
          )}
        </DialogHeader>
        
        <div className="flex-1 overflow-auto">
          {isLoading ? (
            <div className="text-center py-12 flex flex-col items-center gap-3">
              <Loader2 className="w-8 h-8 animate-spin text-primary" />
              <p className="text-muted-foreground">Loading bank statements...</p>
            </div>
          ) : error ? (
            <div className="text-center py-12 flex flex-col items-center gap-3">
              <p className="text-destructive">{(error as Error).message}</p>
              <div className="flex gap-2 mt-4">
                <Button variant="default" onClick={() => refetch()} data-testid="button-retry-statements">
                  Retry
                </Button>
                <Button variant="outline" onClick={onClose}>Close</Button>
              </div>
            </div>
          ) : statements ? (
            <div className="space-y-6">
              <div>
                <h3 className="font-semibold mb-3">Accounts</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {statements.accounts.map((account) => (
                    <Card key={account.accountId} className="p-4" data-testid={`card-account-${account.accountId}`}>
                      <div className="flex justify-between items-start gap-2">
                        <div>
                          <p className="font-medium">{account.name}</p>
                          <p className="text-sm text-muted-foreground capitalize">{account.type} - {account.subtype}</p>
                        </div>
                        <div className="text-right">
                          <p className="font-bold text-lg">${account.currentBalance.toLocaleString()}</p>
                          {account.availableBalance !== null && (
                            <p className="text-xs text-muted-foreground">Available: ${account.availableBalance.toLocaleString()}</p>
                          )}
                        </div>
                      </div>
                    </Card>
                  ))}
                </div>
              </div>
              
              <div>
                <h3 className="font-semibold mb-3">Recent Transactions ({statements.transactions.length})</h3>
                <div className="border rounded-lg overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-muted">
                      <tr>
                        <th className="text-left p-3">Date</th>
                        <th className="text-left p-3">Description</th>
                        <th className="text-left p-3">Category</th>
                        <th className="text-right p-3">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {statements.transactions.slice(0, 50).map((txn) => (
                        <tr key={txn.transactionId} className="border-t" data-testid={`row-transaction-${txn.transactionId}`}>
                          <td className="p-3">{txn.date}</td>
                          <td className="p-3">
                            {txn.name}
                            {txn.pending && <Badge variant="outline" className="ml-2 text-xs">Pending</Badge>}
                          </td>
                          <td className="p-3 text-muted-foreground">{txn.category.join(', ') || 'N/A'}</td>
                          <td className={`p-3 text-right font-medium ${txn.amount < 0 ? 'text-green-600' : 'text-red-600'}`}>
                            {txn.amount < 0 ? '+' : '-'}${Math.abs(txn.amount).toLocaleString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {statements.transactions.length > 50 && (
                    <div className="p-3 text-center text-sm text-muted-foreground bg-muted">
                      Showing 50 of {statements.transactions.length} transactions
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ItemStatementsModal({ 
  plaidItemId, 
  institutionName,
  isOpen,
  onClose 
}: { 
  plaidItemId: string;
  institutionName: string;
  isOpen: boolean;
  onClose: () => void;
}) {
  const { data: statements, isLoading, error, refetch } = useQuery<BankStatement>({
    queryKey: ['/api/plaid/statements-by-item', plaidItemId],
    queryFn: async () => {
      const res = await fetch(`/api/plaid/statements-by-item/${plaidItemId}?months=3`, {
        credentials: 'include',
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to fetch statements');
      }
      return res.json();
    },
    enabled: isOpen && !!plaidItemId,
    retry: 1,
  });

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-hidden flex flex-col" data-testid="dialog-item-statements">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Landmark className="w-5 h-5" />
            Bank Statements - {institutionName}
          </DialogTitle>
          {statements && (
            <p className="text-sm text-muted-foreground">
              {statements.dateRange.startDate} to {statements.dateRange.endDate}
            </p>
          )}
        </DialogHeader>
        
        <div className="flex-1 overflow-auto">
          {isLoading ? (
            <div className="text-center py-12 flex flex-col items-center gap-3">
              <Loader2 className="w-8 h-8 animate-spin text-primary" />
              <p className="text-muted-foreground">Loading bank statements...</p>
            </div>
          ) : error ? (
            <div className="text-center py-12 flex flex-col items-center gap-3">
              <p className="text-destructive">{(error as Error).message}</p>
              <div className="flex gap-2 mt-4">
                <Button variant="default" onClick={() => refetch()} data-testid="button-retry-item-statements">
                  Retry
                </Button>
                <Button variant="outline" onClick={onClose}>Close</Button>
              </div>
            </div>
          ) : statements ? (
            <div className="space-y-6">
              <div>
                <h3 className="font-semibold mb-3">Accounts</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {statements.accounts.map((account) => (
                    <Card key={account.accountId} className="p-4" data-testid={`card-item-account-${account.accountId}`}>
                      <div className="flex justify-between items-start gap-2">
                        <div>
                          <p className="font-medium">{account.name}</p>
                          <p className="text-sm text-muted-foreground capitalize">{account.type} - {account.subtype}</p>
                        </div>
                        <div className="text-right">
                          <p className="font-bold text-lg">${account.currentBalance.toLocaleString()}</p>
                          {account.availableBalance !== null && (
                            <p className="text-xs text-muted-foreground">Available: ${account.availableBalance.toLocaleString()}</p>
                          )}
                        </div>
                      </div>
                    </Card>
                  ))}
                </div>
              </div>
              
              <div>
                <h3 className="font-semibold mb-3">Recent Transactions ({statements.transactions.length})</h3>
                <div className="border rounded-lg overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-muted">
                      <tr>
                        <th className="text-left p-3">Date</th>
                        <th className="text-left p-3">Description</th>
                        <th className="text-left p-3">Category</th>
                        <th className="text-right p-3">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {statements.transactions.slice(0, 50).map((txn) => (
                        <tr key={txn.transactionId} className="border-t" data-testid={`row-item-transaction-${txn.transactionId}`}>
                          <td className="p-3">{txn.date}</td>
                          <td className="p-3">
                            {txn.name}
                            {txn.pending && <Badge variant="outline" className="ml-2 text-xs">Pending</Badge>}
                          </td>
                          <td className="p-3 text-muted-foreground">{txn.category.join(', ') || 'N/A'}</td>
                          <td className={`p-3 text-right font-medium ${txn.amount < 0 ? 'text-green-600' : 'text-red-600'}`}>
                            {txn.amount < 0 ? '+' : '-'}${Math.abs(txn.amount).toLocaleString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {statements.transactions.length > 50 && (
                    <div className="p-3 text-center text-sm text-muted-foreground bg-muted">
                      Showing 50 of {statements.transactions.length} transactions
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface PlaidStatementData {
  id: string;
  plaidItemId: string;
  statementId: string;
  accountId: string;
  accountName: string | null;
  accountType: string | null;
  accountMask: string | null;
  month: number;
  year: number;
  institutionId: string | null;
  institutionName: string | null;
}

function PlaidStatementsModal({ 
  plaidItemId, 
  institutionName,
  isOpen,
  onClose 
}: { 
  plaidItemId: string;
  institutionName: string;
  isOpen: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  
  const { data, isLoading, error, refetch } = useQuery<{ statements: PlaidStatementData[] }>({
    queryKey: ['/api/plaid/stored-statements', plaidItemId],
    queryFn: async () => {
      const res = await fetch(`/api/plaid/stored-statements/${plaidItemId}`, {
        credentials: 'include',
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to fetch statements');
      }
      return res.json();
    },
    enabled: isOpen && !!plaidItemId,
    retry: 1,
  });

  const handleDownload = async (statementId: string, month: number, year: number) => {
    setDownloadingId(statementId);
    try {
      const res = await fetch(`/api/plaid/statements/${plaidItemId}/download/${statementId}`, {
        credentials: 'include',
      });
      
      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.message || 'Failed to download statement');
      }
      
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `bank-statement-${year}-${String(month).padStart(2, '0')}.pdf`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      
      toast({ title: "Success", description: "Statement downloaded successfully" });
    } catch (err: any) {
      toast({ 
        title: "Download Failed", 
        description: err.message || "Could not download statement",
        variant: "destructive"
      });
    } finally {
      setDownloadingId(null);
    }
  };

  const getMonthName = (month: number) => {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return months[month - 1] || 'Unknown';
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-hidden flex flex-col" data-testid="dialog-plaid-statements">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="w-5 h-5" />
            Bank Statements - {institutionName}
          </DialogTitle>
          <p className="text-sm text-muted-foreground">
            Download official bank statements from your connected account
          </p>
        </DialogHeader>
        
        <div className="flex-1 overflow-auto">
          {isLoading ? (
            <div className="text-center py-12 flex flex-col items-center gap-3">
              <Loader2 className="w-8 h-8 animate-spin text-primary" />
              <p className="text-muted-foreground">Loading statements...</p>
            </div>
          ) : error ? (
            <div className="text-center py-12 flex flex-col items-center gap-3">
              <p className="text-destructive">{(error as Error).message}</p>
              <div className="flex gap-2 mt-4">
                <Button variant="default" onClick={() => refetch()} data-testid="button-retry-plaid-statements">
                  Retry
                </Button>
                <Button variant="outline" onClick={onClose}>Close</Button>
              </div>
            </div>
          ) : data?.statements && data.statements.length > 0 ? (
            <div className="space-y-3">
              {data.statements.map((stmt) => (
                <Card key={stmt.id} className="p-4 hover-elevate" data-testid={`card-statement-${stmt.id}`}>
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-primary/10 rounded-lg">
                        <FileText className="w-5 h-5 text-primary" />
                      </div>
                      <div>
                        <p className="font-medium">
                          {getMonthName(stmt.month)} {stmt.year}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {stmt.accountName || 'Account'} {stmt.accountMask ? `••${stmt.accountMask}` : ''}
                        </p>
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleDownload(stmt.statementId, stmt.month, stmt.year)}
                      disabled={downloadingId === stmt.statementId}
                      data-testid={`button-download-statement-${stmt.id}`}
                    >
                      {downloadingId === stmt.statementId ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <>
                          <Download className="w-4 h-4 mr-2" />
                          Download
                        </>
                      )}
                    </Button>
                  </div>
                </Card>
              ))}
            </div>
          ) : (
            <div className="text-center py-12 flex flex-col items-center gap-3">
              <FileText className="w-12 h-12 text-muted-foreground opacity-50" />
              <p className="text-muted-foreground">No statements available yet</p>
              <p className="text-sm text-muted-foreground">
                Statements may take a few minutes to become available after connecting your bank.
              </p>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface AssetReportAccount {
  account_id: string;
  name: string;
  official_name: string | null;
  type: string;
  subtype: string | null;
  balances: {
    current: number | null;
    available: number | null;
  };
  days_available: number;
  historical_balances?: Array<{
    date: string;
    current: number;
  }>;
  transactions?: Array<{
    date: string;
    original_description: string;
    amount: number;
  }>;
}

interface AssetReportItem {
  institution_name: string;
  institution_id: string;
  accounts: AssetReportAccount[];
}

interface AssetReportData {
  report: {
    asset_report_id: string;
    date_generated: string;
    days_requested: number;
    items: AssetReportItem[];
  };
  assetReportToken: string;
}

function AssetReportModal({ 
  plaidItemId, 
  institutionName,
  isOpen,
  onClose 
}: { 
  plaidItemId: string;
  institutionName: string;
  isOpen: boolean;
  onClose: () => void;
}) {
  const [isDownloading, setIsDownloading] = useState(false);

  const { data: assetReport, isLoading, error, refetch } = useQuery<AssetReportData>({
    queryKey: ['/api/plaid/asset-report', plaidItemId],
    queryFn: async () => {
      const res = await fetch(`/api/plaid/asset-report/${plaidItemId}?days=90`, {
        credentials: 'include',
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || data.error || 'Failed to generate asset report');
      }
      return res.json();
    },
    enabled: isOpen && !!plaidItemId,
    retry: false,
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
  });

  const handleDownloadPdf = async () => {
    setIsDownloading(true);
    try {
      const res = await fetch(`/api/plaid/asset-report-pdf/${plaidItemId}?days=90`, {
        credentials: 'include',
      });
      if (!res.ok) {
        throw new Error('Failed to download PDF');
      }
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `asset_report_${institutionName.replace(/\s+/g, '_')}.pdf`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err) {
      console.error('Error downloading PDF:', err);
    } finally {
      setIsDownloading(false);
    }
  };

  const formatCurrency = (amount: number | null) => {
    if (amount === null) return 'N/A';
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-hidden flex flex-col" data-testid="dialog-asset-report">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="w-5 h-5" />
            Asset Report - {institutionName}
          </DialogTitle>
          {assetReport && (
            <p className="text-sm text-muted-foreground">
              Generated: {format(new Date(assetReport.report.date_generated), 'MMM d, yyyy h:mm a')} | 
              {assetReport.report.days_requested} days of data
            </p>
          )}
        </DialogHeader>
        
        <div className="flex-1 overflow-auto">
          {isLoading ? (
            <div className="text-center py-12 flex flex-col items-center gap-3">
              <Loader2 className="w-8 h-8 animate-spin text-primary" />
              <p className="text-muted-foreground">Generating asset report...</p>
              <p className="text-xs text-muted-foreground">This may take 10-30 seconds</p>
            </div>
          ) : error ? (
            <div className="text-center py-12 flex flex-col items-center gap-3">
              <AlertTriangle className="w-8 h-8 text-destructive" />
              <p className="text-destructive">{(error as Error).message}</p>
              <div className="flex gap-2 mt-4">
                <Button variant="default" onClick={() => refetch()} data-testid="button-retry-asset-report">
                  Retry
                </Button>
                <Button variant="outline" onClick={onClose}>Close</Button>
              </div>
            </div>
          ) : assetReport ? (
            <div className="space-y-6">
              {/* Download PDF Button */}
              <div className="flex justify-end">
                <Button 
                  onClick={handleDownloadPdf} 
                  disabled={isDownloading}
                  data-testid="button-download-asset-pdf"
                >
                  {isDownloading ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Download className="w-4 h-4 mr-2" />
                  )}
                  Download PDF
                </Button>
              </div>

              {/* Accounts Summary */}
              {assetReport.report.items.map((item, itemIndex) => (
                <div key={itemIndex} className="space-y-4">
                  <h3 className="font-semibold text-lg flex items-center gap-2">
                    <Landmark className="w-5 h-5" />
                    {item.institution_name}
                  </h3>
                  
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    {item.accounts.map((account) => (
                      <Card key={account.account_id} className="p-4" data-testid={`card-asset-account-${account.account_id}`}>
                        <div className="flex justify-between items-start gap-2 mb-3">
                          <div>
                            <p className="font-medium">{account.name}</p>
                            {account.official_name && (
                              <p className="text-xs text-muted-foreground">{account.official_name}</p>
                            )}
                            <p className="text-sm text-muted-foreground capitalize mt-1">
                              {account.type}{account.subtype ? ` - ${account.subtype}` : ''}
                            </p>
                          </div>
                          <div className="text-right">
                            <p className="font-bold text-lg">{formatCurrency(account.balances.current)}</p>
                            {account.balances.available !== null && (
                              <p className="text-xs text-muted-foreground">
                                Available: {formatCurrency(account.balances.available)}
                              </p>
                            )}
                          </div>
                        </div>

                        <div className="text-xs text-muted-foreground">
                          {account.days_available} days of history available
                        </div>

                        {/* Historical Balances Preview */}
                        {account.historical_balances && account.historical_balances.length > 0 && (
                          <div className="mt-3 pt-3 border-t">
                            <p className="text-xs font-medium mb-2">Recent Balance History</p>
                            <div className="space-y-1">
                              {account.historical_balances.slice(0, 5).map((bal, idx) => (
                                <div key={idx} className="flex justify-between text-xs">
                                  <span className="text-muted-foreground">{bal.date}</span>
                                  <span>{formatCurrency(bal.current)}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Recent Transactions Preview */}
                        {account.transactions && account.transactions.length > 0 && (
                          <div className="mt-3 pt-3 border-t">
                            <p className="text-xs font-medium mb-2">Recent Transactions ({account.transactions.length} total)</p>
                            <div className="space-y-1 max-h-32 overflow-y-auto">
                              {account.transactions.slice(0, 10).map((txn, idx) => (
                                <div key={idx} className="flex justify-between text-xs gap-2">
                                  <span className="text-muted-foreground flex-shrink-0">{txn.date}</span>
                                  <span className="truncate flex-1">{txn.original_description}</span>
                                  <span className={`flex-shrink-0 ${txn.amount < 0 ? 'text-green-600' : 'text-red-600'}`}>
                                    {txn.amount < 0 ? '+' : '-'}{formatCurrency(Math.abs(txn.amount))}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </Card>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Analysis Result Interface (matching OpenAI analysis response)
interface AnalysisResult {
  overallScore: number;
  qualificationTier: string;
  estimatedMonthlyRevenue: number;
  averageDailyBalance: number;
  redFlags: Array<{
    issue: string;
    severity: "low" | "medium" | "high";
    details: string;
  }>;
  positiveIndicators: Array<{
    indicator: string;
    details: string;
  }>;
  fundingRecommendation: {
    eligible: boolean;
    maxAmount: number;
    estimatedRates: string;
    product: string;
    message: string;
  };
  improvementSuggestions: string[];
  summary: string;
}

interface AnalysisResponse {
  success: boolean;
  analysis: AnalysisResult;
  source: "plaid" | "uploaded";
  institutionName?: string;
  businessName?: string;
  filesProcessed?: number;
  timestamp: string;
}

function AnalysisModal({ 
  isOpen,
  onClose,
  analysisData,
  isLoading,
  error,
  title
}: { 
  isOpen: boolean;
  onClose: () => void;
  analysisData: AnalysisResponse | null;
  isLoading: boolean;
  error: string | null;
  title: string;
}) {
  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(amount);
  };

  const getScoreColor = (score: number) => {
    if (score >= 70) return 'text-green-600';
    if (score >= 50) return 'text-yellow-600';
    return 'text-red-600';
  };

  const getScoreLabel = (score: number) => {
    if (score >= 80) return 'Excellent';
    if (score >= 70) return 'Good';
    if (score >= 50) return 'Fair';
    if (score >= 30) return 'Poor';
    return 'Very Poor';
  };

  const getSeverityColor = (severity: string) => {
    if (severity === 'high') return 'text-red-600 bg-red-50 border-red-200 dark:bg-red-900/20 dark:border-red-800';
    if (severity === 'medium') return 'text-yellow-600 bg-yellow-50 border-yellow-200 dark:bg-yellow-900/20 dark:border-yellow-800';
    return 'text-blue-600 bg-blue-50 border-blue-200 dark:bg-blue-900/20 dark:border-blue-800';
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-hidden flex flex-col" data-testid="dialog-analysis">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-primary" />
            AI Fundability Analysis - {title}
          </DialogTitle>
        </DialogHeader>
        
        <div className="flex-1 overflow-auto">
          {isLoading ? (
            <div className="text-center py-12 flex flex-col items-center gap-3">
              <Loader2 className="w-8 h-8 animate-spin text-primary" />
              <p className="font-medium">Analyzing bank statements...</p>
              <p className="text-sm text-muted-foreground">This may take 15-30 seconds</p>
            </div>
          ) : error ? (
            <div className="text-center py-12">
              <AlertCircle className="w-12 h-12 text-destructive mx-auto mb-4" />
              <p className="text-destructive font-medium">Analysis Failed</p>
              <p className="text-sm text-muted-foreground mt-2">{error}</p>
              <Button variant="outline" onClick={onClose} className="mt-4">Close</Button>
            </div>
          ) : analysisData?.analysis ? (
            <div className="space-y-6 p-2">
              {/* Score Overview */}
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <Card className="p-4 text-center col-span-1">
                  <p className="text-sm text-muted-foreground mb-1">Fundability Score</p>
                  <p className={`text-4xl font-bold ${getScoreColor(analysisData.analysis.overallScore)}`}>
                    {analysisData.analysis.overallScore}
                  </p>
                  <p className={`text-sm font-medium ${getScoreColor(analysisData.analysis.overallScore)}`}>
                    {getScoreLabel(analysisData.analysis.overallScore)}
                  </p>
                </Card>
                
                <Card className="p-4 text-center">
                  <p className="text-sm text-muted-foreground mb-1">Qualification Tier</p>
                  <p className="text-lg font-semibold">{analysisData.analysis.qualificationTier}</p>
                </Card>
                
                <Card className="p-4 text-center">
                  <p className="text-sm text-muted-foreground mb-1">Est. Monthly Revenue</p>
                  <p className="text-lg font-semibold text-green-600">
                    {formatCurrency(analysisData.analysis.estimatedMonthlyRevenue)}
                  </p>
                </Card>
                
                <Card className="p-4 text-center">
                  <p className="text-sm text-muted-foreground mb-1">Avg Daily Balance</p>
                  <p className="text-lg font-semibold">
                    {formatCurrency(analysisData.analysis.averageDailyBalance)}
                  </p>
                </Card>
              </div>

              {/* Summary */}
              <Card className="p-4">
                <h3 className="font-semibold mb-2 flex items-center gap-2">
                  <Target className="w-4 h-4" />
                  Executive Summary
                </h3>
                <p className="text-sm text-muted-foreground">{analysisData.analysis.summary}</p>
              </Card>

              {/* Funding Recommendation */}
              <Card className={`p-4 ${analysisData.analysis.fundingRecommendation.eligible ? 'border-green-200 bg-green-50/50 dark:border-green-800 dark:bg-green-900/10' : 'border-yellow-200 bg-yellow-50/50 dark:border-yellow-800 dark:bg-yellow-900/10'}`}>
                <h3 className="font-semibold mb-3 flex items-center gap-2">
                  {analysisData.analysis.fundingRecommendation.eligible ? (
                    <ThumbsUp className="w-4 h-4 text-green-600" />
                  ) : (
                    <ThumbsDown className="w-4 h-4 text-yellow-600" />
                  )}
                  Funding Recommendation
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-3">
                  <div>
                    <p className="text-xs text-muted-foreground">Product</p>
                    <p className="font-medium">{analysisData.analysis.fundingRecommendation.product}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Max Amount</p>
                    <p className="font-medium text-green-600">{formatCurrency(analysisData.analysis.fundingRecommendation.maxAmount)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Est. Rates</p>
                    <p className="font-medium">{analysisData.analysis.fundingRecommendation.estimatedRates}</p>
                  </div>
                </div>
                <p className="text-sm">{analysisData.analysis.fundingRecommendation.message}</p>
              </Card>

              {/* Two Column Layout */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Red Flags */}
                <Card className="p-4">
                  <h3 className="font-semibold mb-3 flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-red-500" />
                    Red Flags ({analysisData.analysis.redFlags.length})
                  </h3>
                  {analysisData.analysis.redFlags.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No red flags detected</p>
                  ) : (
                    <div className="space-y-2">
                      {analysisData.analysis.redFlags.map((flag, idx) => (
                        <div key={idx} className={`p-2 rounded border ${getSeverityColor(flag.severity)}`}>
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium text-sm">{flag.issue}</span>
                            <Badge variant="outline" className="text-xs">{flag.severity}</Badge>
                          </div>
                          <p className="text-xs mt-1 opacity-80">{flag.details}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>

                {/* Positive Indicators */}
                <Card className="p-4">
                  <h3 className="font-semibold mb-3 flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-green-500" />
                    Positive Indicators ({analysisData.analysis.positiveIndicators.length})
                  </h3>
                  {analysisData.analysis.positiveIndicators.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No positive indicators found</p>
                  ) : (
                    <div className="space-y-2">
                      {analysisData.analysis.positiveIndicators.map((indicator, idx) => (
                        <div key={idx} className="p-2 rounded border border-green-200 bg-green-50 text-green-700 dark:bg-green-900/20 dark:border-green-800 dark:text-green-400">
                          <span className="font-medium text-sm">{indicator.indicator}</span>
                          <p className="text-xs mt-1 opacity-80">{indicator.details}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
              </div>

              {/* Improvement Suggestions */}
              {analysisData.analysis.improvementSuggestions.length > 0 && (
                <Card className="p-4">
                  <h3 className="font-semibold mb-3 flex items-center gap-2">
                    <TrendingUp className="w-4 h-4" />
                    Improvement Suggestions
                  </h3>
                  <ul className="space-y-2">
                    {analysisData.analysis.improvementSuggestions.map((suggestion, idx) => (
                      <li key={idx} className="flex items-start gap-2 text-sm">
                        <span className="text-primary mt-0.5">•</span>
                        <span>{suggestion}</span>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}

              {/* Timestamp */}
              <p className="text-xs text-muted-foreground text-right">
                Analysis generated: {format(new Date(analysisData.timestamp), 'MMM d, yyyy h:mm a')}
              </p>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
  "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
  "AB", "BC", "MB", "NB", "NL", "NS", "ON", "PE", "QC", "SK"
];

const INDUSTRIES = [
  "Automotive", "Construction", "Transportation", "Health Services",
  "Utilities and Home Services", "Hospitality", "Entertainment and Recreation",
  "Retail Stores", "Professional Services", "Restaurants & Food Services", "Other"
];

// BusinessDecisionDialogData removed - approvals and declines now use separate dialogs

function ReconnectPlaidButton({ plaidItemId, onSuccess }: { plaidItemId: string; onSuccess: () => void }) {
  const { toast } = useToast();
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess: () => {
      toast({ title: "Bank reconnected", description: "Asset reports are now available for this connection." });
      setLinkToken(null);
      onSuccess();
    },
    onExit: () => {
      setLinkToken(null);
    },
  });

  useEffect(() => {
    if (linkToken && ready) {
      open();
    }
  }, [linkToken, ready, open]);

  const handleReconnect = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/plaid/create-update-link-token/${plaidItemId}`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to create update link token");
      const data = await res.json();
      setLinkToken(data.link_token);
    } catch {
      toast({ title: "Error", description: "Failed to initiate reconnect. Try again.", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleReconnect}
      disabled={loading}
      data-testid={`button-reconnect-plaid-${plaidItemId}`}
    >
      {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Link2 className="w-4 h-4 mr-2" />}
      Reconnect
    </Button>
  );
}

// Underwriter Snapshot — inline financial summary shown on Chirp connection cards
function UnderwriterSnapshot({ email }: { email: string }) {
  const [data, setData] = useState<any>(null);
  const [expanded, setExpanded] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!expanded || loaded) return;
    fetch(`/api/admin/underwriter-snapshot/${encodeURIComponent(email)}`, { credentials: "include" })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setData(d); })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, [email, expanded, loaded]);

  return (
    <div className="mt-3">
      <button
        onClick={() => setExpanded(prev => !prev)}
        className="text-xs text-blue-500 hover:text-blue-400 font-medium flex items-center gap-1"
      >
        {expanded ? "▾" : "▸"} Financial Snapshot
      </button>
      {expanded && (
        <div className="mt-2 p-3 bg-muted/50 rounded-lg text-sm">
          {!loaded ? (
            <p className="text-muted-foreground text-xs">Loading...</p>
          ) : !data?.hasData ? (
            <p className="text-muted-foreground text-xs">No banking data available for this merchant.</p>
          ) : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
                <div>
                  <p className="text-muted-foreground text-xs mb-1">Monthly Revenue</p>
                  <p className="font-semibold text-green-500">${Number(data.metrics.monthlyRevenue).toLocaleString(undefined, { maximumFractionDigits: 0 })}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs mb-1">Monthly Expenses</p>
                  <p className="font-semibold">${Number(data.metrics.monthlyExpenses).toLocaleString(undefined, { maximumFractionDigits: 0 })}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs mb-1">Net Cash Flow</p>
                  <p className={`font-semibold ${data.metrics.netCashFlow >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                    {data.metrics.netCashFlow >= 0 ? '+' : '-'}${Math.abs(data.metrics.netCashFlow).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs mb-1">Current Balance</p>
                  <p className="font-semibold">${Number(data.metrics.currentBalance).toLocaleString(undefined, { maximumFractionDigits: 0 })}</p>
                </div>
              </div>
              <div className="flex items-center gap-4 text-xs text-muted-foreground flex-wrap">
                <span>Avg Balance: ${Number(data.metrics.avgBalance).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                {data.metrics.healthScore > 0 && (
                  <span>
                    Health: <span className={data.metrics.healthScore >= 70 ? 'text-green-500' : data.metrics.healthScore >= 45 ? 'text-yellow-500' : 'text-red-500'} style={{ fontWeight: 600 }}>
                      {data.metrics.healthScore}/100
                    </span>
                  </span>
                )}
                {data.metrics.revenueTrend && (
                  <span>Trend: <span className={data.metrics.revenueTrend === 'growing' ? 'text-green-500' : data.metrics.revenueTrend === 'declining' ? 'text-red-500' : ''} style={{ fontWeight: 500, textTransform: 'capitalize' }}>{data.metrics.revenueTrend}</span></span>
                )}
                {data.metrics.monthsAnalyzed > 0 && <span>{data.metrics.monthsAnalyzed} months analyzed</span>}
                {data.institutionName && <span>{data.institutionName}</span>}
                {data.lastSyncedAt && <span>Last sync: {new Date(data.lastSyncedAt).toLocaleDateString()}</span>}
              </div>
              {/* Monthly breakdown */}
              {data.activityByMonth?.length > 0 && (
                <div className="mt-3 border-t border-muted pt-2">
                  <p className="text-xs text-muted-foreground font-medium mb-2">Monthly Breakdown</p>
                  <div className="grid gap-1 text-xs">
                    {data.activityByMonth.slice(0, 6).map((m: any, i: number) => (
                      <div key={i} className="flex justify-between items-center">
                        <span className="text-muted-foreground w-20">{m.month}</span>
                        <span className="text-green-500 w-24 text-right">+{m.totalCredit}</span>
                        <span className="text-red-400 w-24 text-right">-{m.totalDebit}</span>
                        <span className="w-24 text-right font-medium">{m.averageDailyBalance || '—'}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function BankStatementsTab({ applications = [] }: { applications: LoanApplication[] }) {
  const { toast } = useToast();
  const [expandedBusinesses, setExpandedBusinesses] = useState<Set<string>>(new Set());
  const [analysisModalOpen, setAnalysisModalOpen] = useState(false);
  const [analysisData, setAnalysisData] = useState<AnalysisResponse | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [analysisTitle, setAnalysisTitle] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [showAllStatements, setShowAllStatements] = useState(true);
  const [generatingTokens, setGeneratingTokens] = useState(false);
  const [tokenGenResult, setTokenGenResult] = useState<{ success: boolean; message: string } | null>(null);
  const [updatingApproval, setUpdatingApproval] = useState<string | null>(null);
  const [editingNotes, setEditingNotes] = useState<string | null>(null);
  const [notesInput, setNotesInput] = useState("");
  
  // Business-level underwriting decision state
  const [declineDialog, setDeclineDialog] = useState<{ businessEmail: string; businessName: string } | null>(null);
  const [declineReason, setDeclineReason] = useState('');
  const [declineFollowUp, setDeclineFollowUp] = useState(false);
  const [declineFollowUpDate, setDeclineFollowUpDate] = useState('');
  const [unqualifiedDialog, setUnqualifiedDialog] = useState<{ businessEmail: string; businessName: string } | null>(null);
  const [unqualifiedReason, setUnqualifiedReason] = useState('');
  const [unqualifiedFollowUp, setUnqualifiedFollowUp] = useState(false);
  const [unqualifiedFollowUpDate, setUnqualifiedFollowUpDate] = useState('');
  const [unqualifiedAssignedRep, setUnqualifiedAssignedRep] = useState('');
  const [savingDecision, setSavingDecision] = useState(false);
  const [expandedAdditionalApprovals, setExpandedAdditionalApprovals] = useState<Set<string>>(new Set());
  const [submittingUnderwritingEmails, setSubmittingUnderwritingEmails] = useState<Set<string>>(new Set());
  const [submittedUnderwritingEmails, setSubmittedUnderwritingEmails] = useState<Set<string>>(new Set());

  const handleSubmitToUnderwriting = async (email: string, businessName: string) => {
    if (!email || submittingUnderwritingEmails.has(email)) return;
    setSubmittingUnderwritingEmails(prev => new Set(prev).add(email));
    try {
      const res = await fetch("/api/bank-statements/submit-to-underwriting", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, businessName }),
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || "Failed to submit"); }
      setSubmittedUnderwritingEmails(prev => new Set(prev).add(email));
      toast({ title: "Submitted to Underwriting", description: `underwriting@todaycapitalgroup.com has been notified for ${businessName}.` });
    } catch (err: any) {
      toast({ title: "Submission Failed", description: err.message, variant: "destructive" });
    } finally {
      setSubmittingUnderwritingEmails(prev => { const s = new Set(prev); s.delete(email); return s; });
    }
  };

  // Approval form dialog state (for adding/editing a single approval)
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
  const [approvalFormDialog, setApprovalFormDialog] = useState<{
    businessEmail: string;
    businessName: string;
    editingApprovalId?: string;
  } | null>(null);
  const [approvalForm, setApprovalForm] = useState({
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
    assignedRep: '',
  });
  const [declineAssignedRep, setDeclineAssignedRep] = useState('');

  const [selectedConnection, setSelectedConnection] = useState<BankConnection | null>(null);
  const [selectedAssetReport, setSelectedAssetReport] = useState<BankConnection | null>(null);
  const [selectedStatements, setSelectedStatements] = useState<BankConnection | null>(null);

  // Admin: Plaid connection delete/edit state
  const [deletingConnectionId, setDeletingConnectionId] = useState<string | null>(null);
  const [editingConnection, setEditingConnection] = useState<BankConnection | null>(null);
  const [editConnectionForm, setEditConnectionForm] = useState({ businessName: '', email: '' });
  const [savingConnectionEdit, setSavingConnectionEdit] = useState(false);

  // Admin: Bank upload delete/edit state
  const [deletingUploadId, setDeletingUploadId] = useState<string | null>(null);
  const [editingUpload, setEditingUpload] = useState<BankStatementUpload | null>(null);
  const [editUploadForm, setEditUploadForm] = useState({ businessName: '', email: '' });
  const [savingUploadEdit, setSavingUploadEdit] = useState(false);

  const { data: authData } = useQuery<AuthState | null>({
    queryKey: ['/api/auth/check'],
  });

  const { data: bankConnections, isLoading: connectionsLoading } = useQuery<BankConnection[]>({
    queryKey: ['/api/plaid/all'],
    queryFn: async () => {
      const res = await fetch('/api/plaid/all', { credentials: 'include' });
      if (!res.ok) return [];
      return res.json();
    },
  });

  const { data: chirpConnections, isLoading: chirpConnectionsLoading } = useQuery<ChirpConnection[]>({
    queryKey: ['/api/chirp/connections'],
    queryFn: async () => {
      const res = await fetch('/api/chirp/connections', { credentials: 'include' });
      if (!res.ok) return [];
      return res.json();
    },
  });

  const { data: bankUploads, isLoading: uploadsLoading } = useQuery<BankStatementUpload[]>({
    queryKey: ['/api/bank-statements/uploads'],
    staleTime: 2 * 60 * 1000, // treat data as fresh for 2 min to avoid hammering the DB
    queryFn: async () => {
      const res = await fetch('/api/bank-statements/uploads', {
        credentials: 'include',
      });
      if (!res.ok) {
        throw new Error('Failed to fetch bank statement uploads');
      }
      return res.json();
    },
  });

  const { data: agents } = useQuery<{ name: string; email: string }[]>({
    queryKey: ['/api/agents'],
    queryFn: async () => {
      const res = await fetch('/api/agents', { credentials: 'include' });
      if (!res.ok) return [];
      return res.json();
    },
  });

  // Fetch business-level underwriting decisions
  const { data: underwritingDecisions } = useQuery<BusinessUnderwritingDecision[]>({
    queryKey: ['/api/underwriting-decisions'],
    queryFn: async () => {
      const res = await fetch('/api/underwriting-decisions', {
        credentials: 'include',
      });
      if (!res.ok) {
        return [];
      }
      return res.json();
    },
    enabled: authData?.role === 'admin' || authData?.role === 'underwriting',
  });

  // Helper to get decision for a business by email, with business name fallback
  const getBusinessDecision = (email: string, businessName?: string): BusinessUnderwritingDecision | undefined => {
    const normalized = email.toLowerCase();
    const byEmail = underwritingDecisions?.find(d => (d.businessEmail || '').toLowerCase() === normalized);
    if (byEmail) return byEmail;
    if (businessName && businessName.length > 3) {
      const nameUpper = businessName.toUpperCase().trim();
      return underwritingDecisions?.find(d => {
        const dn = (d.businessName || '').toUpperCase().trim();
        return dn === nameUpper || (nameUpper.length > 5 && dn.includes(nameUpper.slice(0, 15))) || (dn.length > 5 && nameUpper.includes(dn.slice(0, 15)));
      });
    }
    return undefined;
  };

  // Helper: get all approvals for a business from the decision's JSONB (migration-aware)
  const getApprovalsForBusiness = (email: string): FullApprovalEntry[] => {
    const decision = getBusinessDecision(email);
    if (!decision || (decision.status !== 'approved' && decision.status !== 'funded')) return [];

    const raw = decision.additionalApprovals as any[] | null;

    // Check if already in new format (has isPrimary field) AND primary entry is present
    if (raw && raw.length > 0 && raw[0].isPrimary !== undefined) {
      const hasPrimary = (raw as any[]).some((r) => r.isPrimary === true);
      if (hasPrimary) {
        return raw as FullApprovalEntry[];
      }
      // New-format array exists but primary entry was never migrated into it —
      // prepend the flat column data as the primary entry
      const extras = raw as FullApprovalEntry[];
      if (decision.advanceAmount || decision.lender) {
        return [
          {
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
          },
          ...extras,
        ];
      }
      return extras;
    }

    // Migration: convert old format to new
    const result: FullApprovalEntry[] = [];

    // Add the primary (top-level columns) as the first entry
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

    // Add old-format additional approvals
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

  const generateApprovalId = () => `appr-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

  // Open approval form dialog (for adding or editing a single approval)
  const openApprovalForm = (businessEmail: string, businessName: string, editingId?: string) => {
    const decision = getBusinessDecision(businessEmail);
    if (editingId) {
      const approvals = getApprovalsForBusiness(businessEmail);
      const existing = approvals.find(a => a.id === editingId);
      if (existing) {
        setApprovalForm({
          advanceAmount: existing.advanceAmount,
          term: existing.term,
          paymentFrequency: existing.paymentFrequency || 'weekly',
          factorRate: existing.factorRate,
          buyRate: existing.buyRate || '',
          sellRate: existing.sellRate || '',
          maxUpsell: existing.maxUpsell || '',
          totalPayback: existing.totalPayback,
          netAfterFees: existing.netAfterFees,
          lender: existing.lender,
          notes: existing.notes,
          approvalDate: existing.approvalDate || new Date().toISOString().split('T')[0],
          assignedRep: decision?.assignedRep || '',
        });
      }
    } else {
      setApprovalForm({
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
        assignedRep: decision?.assignedRep || '',
      });
    }
    setApprovalFormDialog({ businessEmail, businessName, editingApprovalId: editingId });
  };

  // Open decline dialog
  const openDeclineDialog = (businessEmail: string, businessName: string) => {
    const existing = getBusinessDecision(businessEmail);
    setDeclineReason(existing?.declineReason || '');
    setDeclineFollowUp(existing?.followUpWorthy || false);
    setDeclineFollowUpDate(existing?.followUpDate ? new Date(existing.followUpDate).toISOString().split('T')[0] : '');
    setDeclineAssignedRep(existing?.assignedRep || '');
    setDeclineDialog({ businessEmail, businessName });
  };

  // Open unqualified dialog (didn't even get sent to lenders)
  const openUnqualifiedDialog = (businessEmail: string, businessName: string) => {
    const existing = getBusinessDecision(businessEmail);
    setUnqualifiedReason(existing?.declineReason || '');
    setUnqualifiedFollowUp(existing?.followUpWorthy || false);
    setUnqualifiedFollowUpDate(existing?.followUpDate ? new Date(existing.followUpDate).toISOString().split('T')[0] : '');
    setUnqualifiedAssignedRep(existing?.assignedRep || '');
    setUnqualifiedDialog({ businessEmail, businessName });
  };

  // Save a single approval (add new or edit existing)
  const handleSaveApproval = async () => {
    if (!approvalFormDialog) return;
    setSavingDecision(true);
    try {
      const { businessEmail, businessName, editingApprovalId } = approvalFormDialog;
      const decision = getBusinessDecision(businessEmail);
      let approvals = getApprovalsForBusiness(businessEmail);

      const newEntry: FullApprovalEntry = {
        id: editingApprovalId || generateApprovalId(),
        lender: approvalForm.lender,
        advanceAmount: approvalForm.advanceAmount,
        term: approvalForm.term,
        paymentFrequency: approvalForm.paymentFrequency,
        factorRate: approvalForm.factorRate,
        buyRate: approvalForm.buyRate,
        sellRate: approvalForm.sellRate,
        maxUpsell: approvalForm.maxUpsell,
        totalPayback: approvalForm.totalPayback,
        netAfterFees: approvalForm.netAfterFees,
        notes: approvalForm.notes,
        approvalDate: approvalForm.approvalDate,
        isPrimary: approvals.length === 0, // First approval is automatically primary
        createdAt: editingApprovalId
          ? (approvals.find(a => a.id === editingApprovalId)?.createdAt || new Date().toISOString())
          : new Date().toISOString(),
      };

      if (editingApprovalId) {
        // Replace existing
        const wasEdited = approvals.find(a => a.id === editingApprovalId);
        newEntry.isPrimary = wasEdited?.isPrimary || false;
        approvals = approvals.map(a => a.id === editingApprovalId ? newEntry : a);
      } else {
        approvals.push(newEntry);
      }

      if (decision) {
        // Update existing decision
        const res = await fetch(`/api/underwriting-decisions/${decision.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            additionalApprovals: approvals,
            assignedRep: approvalForm.assignedRep || null,
          }),
        });
        if (!res.ok) {
          const errorData = await res.json().catch(() => ({ error: 'Unknown error' }));
          console.error('Failed to update approval:', errorData);
          toast({ title: "Save Failed", description: errorData.error || `Server returned ${res.status}`, variant: "destructive" });
          return;
        }
      } else {
        // Create new decision
        const res = await fetch('/api/underwriting-decisions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            businessEmail,
            businessName,
            status: 'approved',
            additionalApprovals: approvals,
            assignedRep: approvalForm.assignedRep || null,
          }),
        });
        if (!res.ok) {
          const errorData = await res.json().catch(() => ({ error: 'Unknown error' }));
          console.error('Failed to create approval:', errorData);
          toast({ title: "Save Failed", description: errorData.error || `Server returned ${res.status}`, variant: "destructive" });
          return;
        }
      }

      queryClient.invalidateQueries({ queryKey: ['/api/underwriting-decisions'] });
      setApprovalFormDialog(null);
      toast({ title: "Approval Saved", description: `Approval ${editingApprovalId ? 'updated' : 'added'} for ${businessName}` });
    } catch (error: any) {
      console.error('Error saving approval:', error);
      toast({ title: "Save Failed", description: error.message || "An unexpected error occurred", variant: "destructive" });
    } finally {
      setSavingDecision(false);
    }
  };

  // Set an approval as primary
  const handleSetPrimary = async (businessEmail: string, approvalId: string) => {
    const decision = getBusinessDecision(businessEmail);
    if (!decision) return;
    const approvals = getApprovalsForBusiness(businessEmail).map(a => ({
      ...a,
      isPrimary: a.id === approvalId,
    }));
    try {
      const res = await fetch(`/api/underwriting-decisions/${decision.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ additionalApprovals: approvals }),
      });
      if (res.ok) {
        queryClient.invalidateQueries({ queryKey: ['/api/underwriting-decisions'] });
        toast({ title: "Primary Updated", description: "Primary approval has been changed" });
      }
    } catch (error) {
      console.error('Error setting primary:', error);
    }
  };

  // Delete an individual approval
  const handleDeleteApproval = async (businessEmail: string, approvalId: string) => {
    const decision = getBusinessDecision(businessEmail);
    if (!decision) return;
    let approvals = getApprovalsForBusiness(businessEmail).filter(a => a.id !== approvalId);

    // If deleted the primary and others remain, make the first one primary
    if (approvals.length > 0 && !approvals.some(a => a.isPrimary)) {
      approvals[0].isPrimary = true;
    }

    try {
      if (approvals.length === 0) {
        // No approvals left, delete the decision entirely
        const res = await fetch(`/api/underwriting-decisions/${decision.id}`, {
          method: 'DELETE',
          credentials: 'include',
        });
        if (res.ok) {
          queryClient.invalidateQueries({ queryKey: ['/api/underwriting-decisions'] });
          toast({ title: "Approval Removed", description: "All approvals removed" });
        }
      } else {
        const res = await fetch(`/api/underwriting-decisions/${decision.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ additionalApprovals: approvals }),
        });
        if (res.ok) {
          queryClient.invalidateQueries({ queryKey: ['/api/underwriting-decisions'] });
          toast({ title: "Approval Removed", description: "Approval has been removed" });
        }
      }
    } catch (error) {
      console.error('Error deleting approval:', error);
    }
  };

  // Save decline decision
  const handleSaveDecline = async () => {
    if (!declineDialog) return;
    setSavingDecision(true);
    try {
      const res = await fetch('/api/underwriting-decisions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          businessEmail: declineDialog.businessEmail,
          businessName: declineDialog.businessName,
          status: 'declined',
          declineReason: declineReason || null,
          followUpWorthy: declineFollowUp || false,
          followUpDate: declineFollowUp && declineFollowUpDate ? declineFollowUpDate + 'T12:00:00.000Z' : null,
          assignedRep: declineAssignedRep || null,
        }),
      });
      if (res.ok) {
        queryClient.invalidateQueries({ queryKey: ['/api/underwriting-decisions'] });
        setDeclineDialog(null);
        toast({ title: "Business Declined", description: `${declineDialog.businessName} has been declined` });
      } else {
        const errorData = await res.json().catch(() => ({ error: 'Unknown error' }));
        toast({ title: "Save Failed", description: errorData.error || `Server returned ${res.status}`, variant: "destructive" });
      }
    } catch (error: any) {
      console.error('Error saving decline:', error);
      toast({ title: "Save Failed", description: error.message || "An unexpected error occurred", variant: "destructive" });
    } finally {
      setSavingDecision(false);
    }
  };

  // Save unqualified decision (didn't even get sent to lenders)
  const handleSaveUnqualified = async () => {
    if (!unqualifiedDialog) return;
    setSavingDecision(true);
    try {
      const res = await fetch('/api/underwriting-decisions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          businessEmail: unqualifiedDialog.businessEmail,
          businessName: unqualifiedDialog.businessName,
          status: 'unqualified',
          declineReason: unqualifiedReason || null,
          followUpWorthy: unqualifiedFollowUp || false,
          followUpDate: unqualifiedFollowUp && unqualifiedFollowUpDate ? unqualifiedFollowUpDate + 'T12:00:00.000Z' : null,
          assignedRep: unqualifiedAssignedRep || null,
        }),
      });
      if (res.ok) {
        queryClient.invalidateQueries({ queryKey: ['/api/underwriting-decisions'] });
        setUnqualifiedDialog(null);
        toast({ title: "Marked Unqualified", description: `${unqualifiedDialog.businessName} has been marked as unqualified` });
      } else {
        const errorData = await res.json().catch(() => ({ error: 'Unknown error' }));
        toast({ title: "Save Failed", description: errorData.error || `Server returned ${res.status}`, variant: "destructive" });
      }
    } catch (error: any) {
      console.error('Error saving unqualified:', error);
      toast({ title: "Save Failed", description: error.message || "An unexpected error occurred", variant: "destructive" });
    } finally {
      setSavingDecision(false);
    }
  };

  // Mark a business as funded (change status from approved to funded)
  const handleMarkFunded = async (businessEmail: string) => {
    const decision = getBusinessDecision(businessEmail);
    if (!decision) return;
    try {
      const res = await fetch(`/api/underwriting-decisions/${decision.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ status: 'funded' }),
      });
      if (res.ok) {
        queryClient.invalidateQueries({ queryKey: ['/api/underwriting-decisions'] });
        toast({ title: "Marked as Funded", description: `${decision.businessName || businessEmail} has been marked as funded` });
      }
    } catch (error) {
      console.error('Error marking as funded:', error);
      toast({ title: "Error", description: "Failed to mark as funded", variant: "destructive" });
    }
  };

  // Reset/delete business decision
  const handleResetDecision = async (decisionId: string) => {
    try {
      const res = await fetch(`/api/underwriting-decisions/${decisionId}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (res.ok) {
        queryClient.invalidateQueries({ queryKey: ['/api/underwriting-decisions'] });
      }
    } catch (error) {
      console.error('Error resetting decision:', error);
    }
  };

  // Admin: Delete a Plaid bank connection
  const handleDeleteConnection = async (id: string) => {
    try {
      const res = await fetch(`/api/plaid/connections/${id}`, { method: 'DELETE', credentials: 'include' });
      if (!res.ok) throw new Error('Failed to delete');
      queryClient.invalidateQueries({ queryKey: ['/api/plaid/all'] });
      toast({ title: "Deleted", description: "Bank connection removed" });
    } catch {
      toast({ title: "Error", description: "Failed to delete connection", variant: "destructive" });
    } finally {
      setDeletingConnectionId(null);
    }
  };

  // Admin: Save edits to a Plaid bank connection
  const handleSaveConnectionEdit = async () => {
    if (!editingConnection) return;
    setSavingConnectionEdit(true);
    try {
      const res = await fetch(`/api/plaid/connections/${editingConnection.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(editConnectionForm),
      });
      if (!res.ok) throw new Error('Failed to update');
      queryClient.invalidateQueries({ queryKey: ['/api/plaid/all'] });
      toast({ title: "Saved", description: "Bank connection updated" });
      setEditingConnection(null);
    } catch {
      toast({ title: "Error", description: "Failed to save changes", variant: "destructive" });
    } finally {
      setSavingConnectionEdit(false);
    }
  };

  // Admin: Delete a single bank statement upload
  const handleDeleteUpload = async (id: string) => {
    try {
      const res = await fetch(`/api/bank-statements/${id}`, { method: 'DELETE', credentials: 'include' });
      if (!res.ok) throw new Error('Failed to delete');
      queryClient.invalidateQueries({ queryKey: ['/api/bank-statements/uploads'] });
      toast({ title: "Deleted", description: "Statement upload removed" });
    } catch {
      toast({ title: "Error", description: "Failed to delete upload", variant: "destructive" });
    } finally {
      setDeletingUploadId(null);
    }
  };

  // Admin: Save edits to a bank statement upload
  const handleSaveUploadEdit = async () => {
    if (!editingUpload) return;
    setSavingUploadEdit(true);
    try {
      const res = await fetch(`/api/bank-statements/${editingUpload.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(editUploadForm),
      });
      if (!res.ok) throw new Error('Failed to update');
      queryClient.invalidateQueries({ queryKey: ['/api/bank-statements/uploads'] });
      toast({ title: "Saved", description: "Statement upload updated" });
      setEditingUpload(null);
    } catch {
      toast({ title: "Error", description: "Failed to save changes", variant: "destructive" });
    } finally {
      setSavingUploadEdit(false);
    }
  };

  const getStatusIcon = (status: string) => {
    if (status === 'High') return <TrendingUp className="w-4 h-4 text-green-600" />;
    if (status === 'Low') return <TrendingDown className="w-4 h-4 text-red-600" />;
    return <Minus className="w-4 h-4 text-yellow-600" />;
  };

  const getStatusBadge = (status: string) => {
    if (status === 'High') return <Badge className="bg-green-600 hover:bg-green-700">High</Badge>;
    if (status === 'Low') return <Badge variant="destructive">Low</Badge>;
    return <Badge variant="secondary">Medium</Badge>;
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const handleDownload = async (uploadId: string, fileName: string) => {
    try {
      const res = await fetch(`/api/bank-statements/download/${uploadId}`, {
        credentials: 'include',
      });
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

  const handleView = (uploadId: string) => {
    // Open the PDF in a new browser tab for inline viewing
    window.open(`/api/bank-statements/view/${uploadId}`, '_blank');
  };

  const handleBulkDownload = async (businessName: string) => {
    try {
      const res = await fetch(`/api/bank-statements/download-all/${encodeURIComponent(businessName)}`, {
        credentials: 'include',
      });
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


  const handleAnalyzeUploads = async (businessName: string) => {
    setAnalysisTitle(businessName);
    setAnalysisModalOpen(true);
    setAnalysisLoading(true);
    setAnalysisError(null);
    setAnalysisData(null);

    try {
      const res = await fetch(`/api/bank-statements/analyze/${encodeURIComponent(businessName)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({}),
      });
      
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || data.error || 'Analysis failed');
      }
      
      const data = await res.json();
      setAnalysisData(data);
    } catch (error: any) {
      console.error('Analysis error:', error);
      setAnalysisError(error.message || 'Analysis failed');
    } finally {
      setAnalysisLoading(false);
    }
  };

  const handleAnalyzePlaid = async (connection: BankConnection) => {
    setAnalysisTitle(connection.institutionName);
    setAnalysisModalOpen(true);
    setAnalysisLoading(true);
    setAnalysisError(null);
    setAnalysisData(null);
    try {
      const res = await fetch(`/api/plaid/analyze/${connection.plaidItemId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || data.error || 'Analysis failed');
      }
      const data = await res.json();
      setAnalysisData(data);
    } catch (error: any) {
      setAnalysisError(error.message || 'Analysis failed');
    } finally {
      setAnalysisLoading(false);
    }
  };

  const toggleBusinessExpanded = (businessName: string) => {
    setExpandedBusinesses(prev => {
      const newSet = new Set(prev);
      if (newSet.has(businessName)) {
        newSet.delete(businessName);
      } else {
        newSet.add(businessName);
      }
      return newSet;
    });
  };

  const handleGenerateViewTokens = async () => {
    setGeneratingTokens(true);
    setTokenGenResult(null);
    try {
      const res = await fetch('/api/admin/bank-statements/generate-view-tokens', {
        method: 'POST',
        credentials: 'include',
      });
      const data = await res.json();
      if (res.ok) {
        setTokenGenResult({ success: true, message: data.message || `Generated tokens for ${data.updated} statements` });
        queryClient.invalidateQueries({ queryKey: ['/api/bank-statements/uploads'] });
      } else {
        setTokenGenResult({ success: false, message: data.error || 'Failed to generate tokens' });
      }
    } catch (error) {
      setTokenGenResult({ success: false, message: 'Network error - please try again' });
    } finally {
      setGeneratingTokens(false);
    }
  };

  const handleUpdateApproval = async (uploadId: string, approvalStatus: 'approved' | 'declined', notes?: string) => {
    setUpdatingApproval(uploadId);
    try {
      const res = await fetch(`/api/bank-statements/${uploadId}/approval`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          approvalStatus,
          approvalNotes: notes || null,
        }),
      });
      if (res.ok) {
        queryClient.invalidateQueries({ queryKey: ['/api/bank-statements/uploads'] });
        setEditingNotes(null);
        setNotesInput("");
      } else {
        const data = await res.json();
        console.error('Failed to update approval:', data.error);
      }
    } catch (error) {
      console.error('Error updating approval:', error);
    } finally {
      setUpdatingApproval(null);
    }
  };

  const handleSaveNotes = async (uploadId: string, currentStatus: string | null, notes: string) => {
    if (!currentStatus || (currentStatus !== 'approved' && currentStatus !== 'declined')) {
      console.error('Cannot save notes on pending items - approve or decline first');
      setEditingNotes(null);
      setNotesInput("");
      return;
    }
    setUpdatingApproval(uploadId);
    try {
      const res = await fetch(`/api/bank-statements/${uploadId}/approval`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          approvalStatus: currentStatus,
          approvalNotes: notes || null,
        }),
      });
      if (res.ok) {
        queryClient.invalidateQueries({ queryKey: ['/api/bank-statements/uploads'] });
        setEditingNotes(null);
        setNotesInput("");
      } else {
        const data = await res.json();
        console.error('Failed to save notes:', data.error);
      }
    } catch (error) {
      console.error('Error saving notes:', error);
    } finally {
      setUpdatingApproval(null);
    }
  };

  const getApprovalBadge = (status: string | null) => {
    if (status === 'approved') {
      return <Badge className="bg-green-600 hover:bg-green-700">Approved</Badge>;
    }
    if (status === 'declined') {
      return <Badge variant="destructive">Declined</Badge>;
    }
    return <Badge variant="secondary">Pending Review</Badge>;
  };

  const canManageApprovals = authData?.role === 'underwriting' || authData?.role === 'admin';

  // Group uploads by business name
  const uploadsByBusiness = bankUploads?.reduce((acc, upload) => {
    const businessName = upload.businessName || 'Unknown Business';
    if (!acc[businessName]) {
      acc[businessName] = [];
    }
    acc[businessName].push(upload);
    return acc;
  }, {} as Record<string, BankStatementUpload[]>) || {};

  // Helper: check if a business has been decided (approved/declined/unqualified/funded)
  const emailHasDecision = (email: string, businessName?: string): boolean => {
    if (!email) return false;
    const decision = getBusinessDecision(email, businessName);
    return !!decision && ['approved', 'declined', 'unqualified', 'funded'].includes(decision.status);
  };

  // Filter connections and uploads by search query (and optionally by decision status)
  const lowerQuery = searchQuery.toLowerCase().trim();
  const filteredUploadsByBusiness = Object.entries(uploadsByBusiness).filter(
    ([businessName, uploads]) => {
      const matchesSearch = !lowerQuery || businessName.toLowerCase().includes(lowerQuery);
      const notDecided = showAllStatements || !emailHasDecision(uploads[0]?.email || '', businessName);
      return matchesSearch && notDecided;
    }
  ).sort(([, uploadsA], [, uploadsB]) => {
    const getBestDate = (u: BankStatementUpload): number => {
      if (u.receivedAt) return new Date(u.receivedAt).getTime();
      if (u.createdAt) return new Date(u.createdAt).getTime();
      return 0;
    };
    const mostRecentA = Math.max(...uploadsA.map(getBestDate));
    const mostRecentB = Math.max(...uploadsB.map(getBestDate));
    return mostRecentB - mostRecentA;
  });

  // Filter & sort Plaid connections (newest first; hide decided businesses unless showAllStatements)
  const filteredConnections = (bankConnections || [])
    .filter(conn => {
      const matchesSearch = !lowerQuery || conn.businessName.toLowerCase().includes(lowerQuery) || conn.email.toLowerCase().includes(lowerQuery);
      const notDecided = showAllStatements || !emailHasDecision(conn.email);
      return matchesSearch && notDecided;
    })
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  // Filter & sort Chirp connections
  const filteredChirpConnections = (chirpConnections || [])
    .filter(conn => {
      const name = conn.businessName || conn.fullName || '';
      const matchesSearch = !lowerQuery || name.toLowerCase().includes(lowerQuery) || conn.email.toLowerCase().includes(lowerQuery);
      const notDecided = showAllStatements || !emailHasDecision(conn.email);
      return matchesSearch && notDecided;
    })
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const isLoading = uploadsLoading || connectionsLoading || chirpConnectionsLoading;
  const hasUploads = filteredUploadsByBusiness.length > 0;
  const hasConnections = filteredConnections.length > 0;
  const hasChirpConnections = filteredChirpConnections.length > 0;
  const isEmpty = !hasUploads && !hasConnections && !hasChirpConnections;

  // Check if there's any data at all (before search filtering)
  const hasAnyData = (bankUploads && bankUploads.length > 0) || (bankConnections && bankConnections.length > 0) || (chirpConnections && chirpConnections.length > 0);

  if (isLoading) {
    return (
      <Card className="p-12" data-testid="card-bank-loading">
        <div className="text-center flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
          <p className="text-muted-foreground">Loading bank statements...</p>
        </div>
      </Card>
    );
  }

  if (!hasAnyData) {
    return (
      <Card className="p-12" data-testid="card-bank-empty">
        <div className="text-center">
          <Landmark className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
          <h3 className="text-lg font-semibold mb-2">No Bank Statements</h3>
          <p className="text-muted-foreground">
            Bank connections and uploaded statements will appear here.
          </p>
        </div>
      </Card>
    );
  }

  return (
    <>
      <div className="space-y-6">
        {/* Search Bar and Admin Actions */}
        <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
          <div className="relative w-full sm:max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              type="text"
              placeholder="Search by business name..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
              data-testid="input-bank-search"
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowAllStatements(v => !v)}
            className={showAllStatements ? "toggle-elevate toggle-elevated" : "toggle-elevate"}
            data-testid="button-toggle-show-all-statements"
          >
            <Eye className="w-4 h-4 mr-2" />
            {showAllStatements ? "Pending Only" : "Show All Statements"}
          </Button>
        </div>

        {/* No results message */}
        {isEmpty && searchQuery && (
          <Card className="p-8" data-testid="card-no-results">
            <div className="text-center text-muted-foreground">
              No bank statements match "{searchQuery}"
            </div>
          </Card>
        )}

        {/* PDF Uploads Section - Grouped by Business */}
        {hasUploads && (
          <div>
            <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <Upload className="w-5 h-5" />
              Uploaded Statements
            </h3>
            <div className="space-y-4">
              {filteredUploadsByBusiness.map(([businessName, uploads]) => (
                <Card key={businessName} className="p-6 hover-elevate" data-testid={`card-business-${businessName}`}>
                  {/* Business Header */}
                  <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 mb-4">
                    <div className="flex items-center gap-3 flex-wrap">
                      <button
                        onClick={() => toggleBusinessExpanded(businessName)}
                        className="flex items-center gap-2 hover:opacity-70 transition-opacity"
                        data-testid={`button-toggle-${businessName}`}
                      >
                        {expandedBusinesses.has(businessName) ? (
                          <ChevronDown className="w-5 h-5 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="w-5 h-5 text-muted-foreground" />
                        )}
                        <Building2 className="w-5 h-5 text-primary" />
                        <h4 className="font-semibold text-lg">{businessName}</h4>
                      </button>
                      <Badge variant="secondary" className="flex items-center gap-1">
                        <FileText className="w-3 h-3" />
                        {uploads.length} {uploads.length === 1 ? 'Statement' : 'Statements'}
                      </Badge>
                      
                      {/* Business-level Underwriting Decision Status & Toggle */}
                      {canManageApprovals && (() => {
                        const businessEmail = uploads[0]?.email;
                        if (!businessEmail) return null;
                        const decision = getBusinessDecision(businessEmail, businessName);

                        if (decision) {
                          const approvalUrl = decision.approvalSlug
                            ? `${window.location.origin}/approved/${decision.approvalSlug}`
                            : null;

                          const copyApprovalUrl = () => {
                            if (approvalUrl) {
                              navigator.clipboard.writeText(approvalUrl);
                              toast({ title: "URL Copied", description: "Approval letter URL copied to clipboard" });
                            }
                          };

                          return (
                            <div className="flex items-center gap-2 flex-wrap">
                              {decision.status === 'approved' && (
                                <>
                                  <Badge className="bg-green-600 hover:bg-green-700 flex items-center gap-1">
                                    <ThumbsUp className="w-3 h-3" />
                                    Approved
                                  </Badge>
                                  {approvalUrl && (
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={copyApprovalUrl}
                                      className="text-primary border-primary/30 hover:bg-primary/10"
                                      data-testid={`button-copy-approval-url-${businessEmail}`}
                                    >
                                      <Copy className="w-3 h-3 mr-1" />
                                      Copy Letter URL
                                    </Button>
                                  )}
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => openApprovalForm(businessEmail, businessName)}
                                    className="text-green-600 border-green-200 hover:bg-green-50 dark:border-green-800 dark:hover:bg-green-900/20"
                                    data-testid={`button-add-approval-${businessEmail}`}
                                  >
                                    <Plus className="w-3 h-3 mr-1" />
                                    Add Approval
                                  </Button>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => handleMarkFunded(businessEmail)}
                                    className="text-purple-600 border-purple-200 hover:bg-purple-50 dark:border-purple-800 dark:hover:bg-purple-900/20"
                                    data-testid={`button-mark-funded-${businessEmail}`}
                                  >
                                    <Banknote className="w-3 h-3 mr-1" />
                                    Mark Funded
                                  </Button>
                                </>
                              )}
                              {decision.status === 'funded' && (
                                <>
                                  <Badge className="bg-purple-600 hover:bg-purple-700 flex items-center gap-1">
                                    <Banknote className="w-3 h-3" />
                                    Funded
                                  </Badge>
                                  {approvalUrl && (
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={copyApprovalUrl}
                                      className="text-primary border-primary/30 hover:bg-primary/10"
                                      data-testid={`button-copy-funded-url-${businessEmail}`}
                                    >
                                      <Copy className="w-3 h-3 mr-1" />
                                      Copy Letter URL
                                    </Button>
                                  )}
                                </>
                              )}
                              {decision.status === 'declined' && (
                                <>
                                  <Badge variant="destructive" className="flex items-center gap-1">
                                    <ThumbsDown className="w-3 h-3" />
                                    Declined
                                  </Badge>
                                  {decision.followUpWorthy && (
                                    <Badge variant="outline" className="flex items-center gap-1 text-blue-600 border-blue-200 dark:text-blue-400 dark:border-blue-800">
                                      <CalendarIcon className="w-3 h-3" />
                                      Follow Up{decision.followUpDate ? `: ${new Date(decision.followUpDate).toLocaleDateString('en-US', { timeZone: 'UTC' })}` : ''}
                                    </Badge>
                                  )}
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => openDeclineDialog(businessEmail, businessName)}
                                    data-testid={`button-edit-decision-${businessEmail}`}
                                  >
                                    <Pencil className="w-3 h-3" />
                                  </Button>
                                </>
                              )}
                              {decision.status === 'unqualified' && (
                                <>
                                  <Badge className="bg-orange-600 hover:bg-orange-700 flex items-center gap-1">
                                    <AlertCircle className="w-3 h-3" />
                                    Unqualified
                                  </Badge>
                                  {/* GigFi outcomes live on the Unqualified page (/unqualified) to keep this view uncluttered */}
                                  {decision.followUpWorthy && (
                                    <Badge variant="outline" className="flex items-center gap-1 text-blue-600 border-blue-200 dark:text-blue-400 dark:border-blue-800">
                                      <CalendarIcon className="w-3 h-3" />
                                      Follow Up{decision.followUpDate ? `: ${new Date(decision.followUpDate).toLocaleDateString('en-US', { timeZone: 'UTC' })}` : ''}
                                    </Badge>
                                  )}
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => openUnqualifiedDialog(businessEmail, businessName)}
                                    data-testid={`button-edit-unqualified-${businessEmail}`}
                                  >
                                    <Pencil className="w-3 h-3" />
                                  </Button>
                                </>
                              )}
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleResetDecision(decision.id)}
                                className="text-muted-foreground"
                                data-testid={`button-reset-decision-${businessEmail}`}
                              >
                                <X className="w-3 h-3" />
                              </Button>
                            </div>
                          );
                        }

                        return (
                          <div className="flex items-center gap-1">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => openApprovalForm(businessEmail, businessName)}
                              className="text-green-600 border-green-200 hover:bg-green-50 dark:border-green-800 dark:hover:bg-green-900/20"
                              data-testid={`button-approve-business-${businessEmail}`}
                            >
                              <ThumbsUp className="w-3 h-3 mr-1" />
                              Approve
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => openDeclineDialog(businessEmail, businessName)}
                              className="text-red-600 border-red-200 hover:bg-red-50 dark:border-red-800 dark:hover:bg-red-900/20"
                              data-testid={`button-decline-business-${businessEmail}`}
                            >
                              <ThumbsDown className="w-3 h-3 mr-1" />
                              Decline
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => openUnqualifiedDialog(businessEmail, businessName)}
                              className="text-orange-600 border-orange-200 hover:bg-orange-50 dark:border-orange-800 dark:hover:bg-orange-900/20"
                              data-testid={`button-unqualified-business-${businessEmail}`}
                            >
                              <AlertCircle className="w-3 h-3 mr-1" />
                              Unqualified
                            </Button>
                          </div>
                        );
                      })()}
                    </div>
                    <div className="flex gap-2 flex-wrap">
                      <Button
                        variant="outline"
                        onClick={() => handleAnalyzeUploads(businessName)}
                        className="bg-gradient-to-r from-purple-500/10 to-blue-500/10 hover:from-purple-500/20 hover:to-blue-500/20 border-purple-200 dark:border-purple-800"
                        data-testid={`button-analyze-uploads-${businessName}`}
                      >
                        <Sparkles className="w-4 h-4 mr-2 text-purple-500" />
                        Analyze
                      </Button>
                      <Button
                        variant="outline"
                        onClick={async () => {
                          const email = uploads[0]?.email;
                          if (!email) return;
                          try {
                            const res = await fetch(`/api/bank-statements/view-url?email=${encodeURIComponent(email)}`, {
                              credentials: 'include'
                            });
                            if (res.ok) {
                              const data = await res.json();
                              window.open(data.url, '_blank');
                            }
                          } catch (err) {
                            console.error('Failed to get view URL:', err);
                          }
                        }}
                        className="bg-gradient-to-r from-blue-500/10 to-cyan-500/10 hover:from-blue-500/20 hover:to-cyan-500/20 border-blue-200 dark:border-blue-800"
                        data-testid={`button-view-all-${businessName}`}
                      >
                        <Eye className="w-4 h-4 mr-2 text-blue-500" />
                        View All
                      </Button>
                      {(() => {
                        const bizEmail = uploads[0]?.email;
                        if (!bizEmail) return null;
                        const isSubmitting = submittingUnderwritingEmails.has(bizEmail);
                        const isSubmitted = submittedUnderwritingEmails.has(bizEmail);
                        const matchingApp = applications.find(a => a.email?.toLowerCase() === bizEmail.toLowerCase());
                        const uwDate = matchingApp?.uwSubmittedAt ? new Date(matchingApp.uwSubmittedAt) : null;
                        const wasSubmitted = isSubmitted || !!uwDate;
                        const submittedLabel = uwDate
                          ? `Submitted ${uwDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
                          : 'Submitted';
                        return (
                          <Button
                            variant="outline"
                            onClick={() => handleSubmitToUnderwriting(bizEmail, businessName)}
                            disabled={isSubmitting || wasSubmitted}
                            className={wasSubmitted
                              ? "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-400"
                              : "bg-gradient-to-r from-green-500/10 to-teal-500/10 hover:from-green-500/20 hover:to-teal-500/20 border-green-200 dark:border-green-800"}
                            data-testid={`button-submit-underwriting-${businessName}`}
                          >
                            {isSubmitting ? (
                              <><Loader2 className="w-4 h-4 mr-2 animate-spin text-green-600" />Submitting…</>
                            ) : wasSubmitted ? (
                              <><CheckCircle2 className="w-4 h-4 mr-2 text-amber-600 dark:text-amber-400" />{submittedLabel}</>
                            ) : (
                              <><Send className="w-4 h-4 mr-2 text-green-600" />Submit to Underwriting</>
                            )}
                          </Button>
                        );
                      })()}
                      <Button
                        onClick={() => handleBulkDownload(businessName)}
                        className="bg-primary hover:bg-primary/90"
                        data-testid={`button-download-all-${businessName}`}
                      >
                        <FolderArchive className="w-4 h-4 mr-2" />
                        Download All ({uploads.length})
                      </Button>
                    </div>
                  </div>

                  {/* Inline Approvals List - Best at top with dropdown */}
                  {canManageApprovals && (() => {
                    const businessEmail = uploads[0]?.email;
                    if (!businessEmail) return null;
                    const decision = getBusinessDecision(businessEmail, businessName);
                    if (!decision || (decision.status !== 'approved' && decision.status !== 'funded')) return null;
                    const approvals = getApprovalsForBusiness(businessEmail);
                    if (approvals.length === 0) return null;

                    const sortedApprovals = [...approvals].sort((a, b) => {
                      // Sort all approvals newest to oldest by approvalDate
                      const dateA = a.approvalDate || a.createdAt || '';
                      const dateB = b.approvalDate || b.createdAt || '';
                      return dateB.localeCompare(dateA);
                    });
                    const bestApproval = sortedApprovals[0];
                    const additionalApprovals = sortedApprovals.slice(1);
                    const isAdditionalExpanded = expandedAdditionalApprovals.has(businessEmail);

                    const renderInlineApproval = (appr: FullApprovalEntry) => (
                      <div
                        key={appr.id}
                        className={`flex items-center justify-between gap-3 p-3 rounded-lg text-sm ${
                          appr.isPrimary
                            ? 'bg-green-50 border border-green-200 dark:bg-green-900/20 dark:border-green-800'
                            : 'bg-muted/50 border border-transparent'
                        }`}
                      >
                        <div className="flex items-center gap-3 flex-1 min-w-0 flex-wrap">
                          <button
                            onClick={() => handleSetPrimary(businessEmail, appr.id)}
                            className={`flex-shrink-0 ${appr.isPrimary ? 'text-yellow-500' : 'text-muted-foreground hover:text-yellow-500'}`}
                            title={appr.isPrimary ? 'Best approval' : 'Set as best approval'}
                            data-testid={`button-set-primary-${appr.id}`}
                          >
                            <Star className={`w-4 h-4 ${appr.isPrimary ? 'fill-yellow-500' : ''}`} />
                          </button>
                          {appr.isPrimary && (
                            <Badge className="bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300 text-xs">
                              Best Approval
                            </Badge>
                          )}
                          <span className="font-medium">{appr.lender || 'No lender'}</span>
                          {appr.advanceAmount && (
                            <span className="text-green-600 dark:text-green-400 font-semibold">
                              ${parseFloat(appr.advanceAmount).toLocaleString()}
                                </span>
                              )}
                              {appr.term && <span className="text-muted-foreground">{appr.term}</span>}
                              {appr.factorRate && <span className="text-muted-foreground">{appr.factorRate}x</span>}
                              {appr.paymentFrequency && <span className="text-muted-foreground capitalize">{appr.paymentFrequency}</span>}
                              {appr.approvalDate && (() => {
                                const raw = appr.approvalDate;
                                const d = new Date(raw.includes('T') ? raw : raw + 'T00:00:00');
                                return !isNaN(d.getTime()) ? (
                                  <span className="text-muted-foreground text-xs">
                                    {format(d, 'MMM d, yyyy')}
                                  </span>
                                ) : null;
                              })()}
                            </div>
                            <div className="flex items-center gap-1 flex-shrink-0">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => openApprovalForm(businessEmail, businessName, appr.id)}
                                data-testid={`button-edit-approval-${appr.id}`}
                              >
                                <Pencil className="w-3 h-3" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleDeleteApproval(businessEmail, appr.id)}
                                className="text-red-500 hover:text-red-700"
                                data-testid={`button-delete-approval-${appr.id}`}
                              >
                                <Trash2 className="w-3 h-3" />
                              </Button>
                            </div>
                          </div>
                        );

                    return (
                      <div className="mb-4 space-y-2">
                        {bestApproval && renderInlineApproval(bestApproval)}
                        {additionalApprovals.length > 0 && (
                          <div>
                            <button
                              onClick={() => setExpandedAdditionalApprovals(prev => {
                                const next = new Set(prev);
                                if (next.has(businessEmail)) next.delete(businessEmail);
                                else next.add(businessEmail);
                                return next;
                              })}
                              className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors py-1"
                              data-testid={`button-toggle-additional-${businessEmail}`}
                            >
                              {isAdditionalExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                              {isAdditionalExpanded ? 'Hide' : 'View'} {additionalApprovals.length} Additional {additionalApprovals.length === 1 ? 'Approval' : 'Approvals'}
                            </button>
                            {isAdditionalExpanded && (
                              <div className="space-y-2 mt-2">
                                {additionalApprovals.map(renderInlineApproval)}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {/* Merchant Profile Enhancements */}
                  {uploads[0]?.email && (() => {
                    const profileEmail = uploads[0].email;
                    const profileApp = applications.find(a => a.email?.toLowerCase() === profileEmail.toLowerCase());
                    const profileDecision = getBusinessDecision(profileEmail, businessName);
                    const profilePhone = profileApp?.phone || profileDecision?.businessPhone || '';
                    return (
                      <div className="space-y-0">
                        <BankStatementSnapshot
                          email={profileEmail}
                          businessName={businessName}
                          creditScore={profileApp?.ficoScoreExact || profileApp?.creditScore || undefined}
                          timeInBusiness={(profileApp as any)?.timeInBusiness || undefined}
                          industry={profileApp?.industry || undefined}
                          compact
                        />
                        <CallHistory phone={profilePhone} />
                        <MerchantNotes email={profileEmail} businessName={businessName} />
                      </div>
                    );
                  })()}

                  {/* Individual Files - Collapsible */}
                  {expandedBusinesses.has(businessName) && (
                    <div className="space-y-3 pt-4 border-t">
                      {uploads.map((upload) => (
                        <div key={upload.id} className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 p-3 bg-muted/50 rounded-lg" data-testid={`card-bank-upload-${upload.id}`}>
                          <div className="flex-1">
                            <div className="flex items-center gap-3 mb-2 flex-wrap">
                              <span className="font-medium flex items-center gap-2">
                                <FileText className="w-4 h-4 text-primary" />
                                {upload.originalFileName}
                              </span>
                              {upload.source === "Checker" && (
                                <Badge variant="outline" className="flex items-center gap-1 bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-700 text-xs">
                                  <TrendingUp className="w-3 h-3" />
                                  Checker
                                </Badge>
                              )}
                            </div>
                            <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
                              <span>{formatFileSize(upload.fileSize)}</span>
                              <span>{(() => { const d = upload.createdAt ? new Date(upload.createdAt) : null; return d && !isNaN(d.getTime()) ? format(d, 'MMM d, yyyy') : 'N/A'; })()}</span>
                              <span className="flex items-center gap-1">
                                <User className="w-3 h-3" />
                                {upload.email}
                              </span>
                            </div>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleView(upload.id)}
                              data-testid={`button-view-statement-${upload.id}`}
                            >
                              <Eye className="w-4 h-4 mr-1" />
                              View
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleDownload(upload.id, upload.originalFileName)}
                              data-testid={`button-download-statement-${upload.id}`}
                            >
                              <Download className="w-4 h-4 mr-1" />
                              Download
                            </Button>
                            {authData?.role === 'admin' && (
                              <Button
                                variant="outline"
                                size="sm"
                                className="text-red-600 border-red-200 dark:border-red-800"
                                data-testid={`button-delete-upload-${upload.id}`}
                                onClick={() => setDeletingUploadId(upload.id)}
                              >
                                <Trash2 className="w-4 h-4 mr-1" />
                                Delete
                              </Button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
              ))}
            </div>
          </div>
        )}

        {/* Plaid Connected Banks Section */}
        {hasConnections && (
          <div>
            <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <Landmark className="w-5 h-5 text-emerald-600" />
              Plaid Connected Banks
              <Badge className="bg-emerald-600 text-white text-xs">{filteredConnections.length}</Badge>
            </h3>
            <div className="space-y-4">
              {filteredConnections.map((connection) => (
                <Card key={connection.id} className="p-6 hover-elevate" data-testid={`card-bank-connection-${connection.id}`}>
                  <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-3 flex-wrap">
                        <h4 className="font-semibold text-lg flex items-center gap-2">
                          <Building2 className="w-5 h-5 text-primary" />
                          {connection.businessName}
                        </h4>
                        <Badge variant="outline" className="flex items-center gap-1">
                          <Landmark className="w-3 h-3" />
                          {connection.institutionName}
                        </Badge>
                        <Badge className="bg-emerald-600 text-white">Plaid Connected</Badge>
                        {(() => {
                          const decision = getBusinessDecision(connection.email);
                          if (!decision) return null;
                          const statusColors: Record<string, string> = {
                            approved: 'bg-blue-600 text-white',
                            funded: 'bg-purple-600 text-white',
                            declined: 'bg-red-600 text-white',
                            unqualified: 'bg-amber-600 text-white',
                          };
                          const statusLabels: Record<string, string> = {
                            approved: 'Approved',
                            funded: 'Funded',
                            declined: 'Declined',
                            unqualified: 'Unqualified',
                          };
                          const cls = statusColors[decision.status] || 'bg-muted text-muted-foreground';
                          const label = statusLabels[decision.status] || decision.status;
                          return <Badge className={cls}>{label}</Badge>;
                        })()}
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-3">
                        <div className="flex items-center gap-2 text-sm">
                          <DollarSign className="w-4 h-4 text-muted-foreground" />
                          <span className="text-muted-foreground">Monthly Revenue:</span>
                          <span className="font-medium">${parseFloat(connection.monthlyRevenue).toLocaleString()}</span>
                        </div>
                        <div className="flex items-center gap-2 text-sm">
                          <Landmark className="w-4 h-4 text-muted-foreground" />
                          <span className="text-muted-foreground">Avg Balance:</span>
                          <span className="font-medium">${parseFloat(connection.avgBalance).toLocaleString()}</span>
                        </div>
                        <div className="flex items-center gap-2 text-sm">
                          <CalendarIcon className="w-4 h-4 text-muted-foreground" />
                          <span className="text-muted-foreground">Connected:</span>
                          <span className="font-medium">{format(new Date(connection.createdAt), 'MMM d, yyyy')}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <User className="w-4 h-4" />
                        {connection.email}
                      </div>
                    </div>
                    <div className="flex flex-col gap-2 min-w-[140px]">
                      <Button
                        onClick={() => setSelectedStatements(connection)}
                        data-testid={`button-view-statements-${connection.id}`}
                        size="sm"
                      >
                        <FileText className="w-4 h-4 mr-2" />
                        Bank Statements
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setSelectedAssetReport(connection)}
                        data-testid={`button-view-asset-report-${connection.id}`}
                      >
                        <Landmark className="w-4 h-4 mr-2" />
                        Asset Report
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleAnalyzePlaid(connection)}
                        data-testid={`button-analyze-plaid-${connection.id}`}
                      >
                        <Sparkles className="w-4 h-4 mr-2 text-purple-500" />
                        Analyze
                      </Button>
                      <ReconnectPlaidButton
                        plaidItemId={connection.plaidItemId}
                        onSuccess={() => queryClient.invalidateQueries({ queryKey: ['/api/plaid/all'] })}
                      />
                      {authData?.role === 'admin' && (
                        <div className="flex gap-2 pt-1 border-t border-border mt-1">
                          <Button
                            variant="outline"
                            size="sm"
                            className="flex-1 text-blue-600 border-blue-200 dark:border-blue-800"
                            data-testid={`button-edit-connection-${connection.id}`}
                            onClick={() => {
                              setEditingConnection(connection);
                              setEditConnectionForm({ businessName: connection.businessName, email: connection.email });
                            }}
                          >
                            <Pencil className="w-3 h-3 mr-1" />
                            Edit
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="flex-1 text-red-600 border-red-200 dark:border-red-800"
                            data-testid={`button-delete-connection-${connection.id}`}
                            onClick={() => setDeletingConnectionId(connection.id)}
                          >
                            <Trash2 className="w-3 h-3 mr-1" />
                            Delete
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          </div>
        )}

        {/* Chirp Connected Banks Section */}
        {hasChirpConnections && (
          <div>
            <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <Landmark className="w-5 h-5 text-blue-600" />
              Chirp Connected Banks
              <Badge className="bg-blue-600 text-white text-xs">{filteredChirpConnections.length}</Badge>
            </h3>
            <div className="space-y-4">
              {filteredChirpConnections.map((conn) => (
                <Card key={conn.id} className="p-6 hover-elevate" data-testid={`card-chirp-connection-${conn.id}`}>
                  <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-3 flex-wrap">
                        <h4 className="font-semibold text-lg flex items-center gap-2">
                          <Building2 className="w-5 h-5 text-primary" />
                          {conn.businessName || conn.fullName}
                        </h4>
                        <Badge className="bg-blue-600 text-white">Chirp Connected</Badge>
                        {(() => {
                          const decision = getBusinessDecision(conn.email);
                          if (!decision) return null;
                          const statusColors: Record<string, string> = {
                            approved: 'bg-blue-600 text-white',
                            funded: 'bg-purple-600 text-white',
                            declined: 'bg-red-600 text-white',
                            unqualified: 'bg-amber-600 text-white',
                          };
                          const statusLabels: Record<string, string> = {
                            approved: 'Approved',
                            funded: 'Funded',
                            declined: 'Declined',
                            unqualified: 'Unqualified',
                          };
                          const cls = statusColors[decision.status] || 'bg-muted text-muted-foreground';
                          const label = statusLabels[decision.status] || decision.status;
                          return <Badge className={cls}>{label}</Badge>;
                        })()}
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-3">
                        <div className="flex items-center gap-2 text-sm">
                          <User className="w-4 h-4 text-muted-foreground" />
                          <span className="text-muted-foreground">Applicant:</span>
                          <span className="font-medium">{conn.fullName}</span>
                        </div>
                        <div className="flex items-center gap-2 text-sm">
                          <CalendarIcon className="w-4 h-4 text-muted-foreground" />
                          <span className="text-muted-foreground">Connected:</span>
                          <span className="font-medium">{format(new Date(conn.createdAt), 'MMM d, yyyy')}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <User className="w-4 h-4" />
                        {conn.email}
                      </div>
                      {/* Underwriter Snapshot — inline financial summary */}
                      <UnderwriterSnapshot email={conn.email} />
                    </div>
                    <div className="flex flex-col gap-2 min-w-[160px]">
                      <Button
                        size="sm"
                        onClick={() => window.open(`/api/chirp/request/${conn.chirpRequestCode}/pdf/download`, '_blank')}
                        data-testid={`button-chirp-pdf-${conn.id}`}
                      >
                        <FileText className="w-4 h-4 mr-2" />
                        Download PDF
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => window.open(`/api/chirp/request/${conn.chirpRequestCode}/details`, '_blank')}
                        data-testid={`button-chirp-details-${conn.id}`}
                      >
                        <Landmark className="w-4 h-4 mr-2" />
                        View Details
                      </Button>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          </div>
        )}

      </div>


      {selectedConnection && (
        <ItemStatementsModal
          plaidItemId={selectedConnection.plaidItemId}
          institutionName={selectedConnection.institutionName}
          isOpen={!!selectedConnection}
          onClose={() => setSelectedConnection(null)}
        />
      )}

      {selectedAssetReport && (
        <AssetReportModal
          plaidItemId={selectedAssetReport.plaidItemId}
          institutionName={selectedAssetReport.institutionName}
          isOpen={!!selectedAssetReport}
          onClose={() => setSelectedAssetReport(null)}
        />
      )}

      {selectedStatements && (
        <PlaidStatementsModal
          plaidItemId={selectedStatements.plaidItemId}
          institutionName={selectedStatements.institutionName}
          isOpen={!!selectedStatements}
          onClose={() => setSelectedStatements(null)}
        />
      )}

      <AnalysisModal
        isOpen={analysisModalOpen}
        onClose={() => {
          setAnalysisModalOpen(false);
          setAnalysisData(null);
          setAnalysisError(null);
        }}
        analysisData={analysisData}
        isLoading={analysisLoading}
        error={analysisError}
        title={analysisTitle}
      />

      {/* Admin: Edit Plaid Connection Dialog */}
      <Dialog open={!!editingConnection} onOpenChange={(open) => !open && setEditingConnection(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="w-4 h-4" />
              Edit Bank Connection
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div>
              <Label>Business Name</Label>
              <Input
                data-testid="input-edit-connection-business"
                value={editConnectionForm.businessName}
                onChange={(e) => setEditConnectionForm(f => ({ ...f, businessName: e.target.value }))}
                placeholder="Business name"
              />
            </div>
            <div>
              <Label>Email</Label>
              <Input
                data-testid="input-edit-connection-email"
                value={editConnectionForm.email}
                onChange={(e) => setEditConnectionForm(f => ({ ...f, email: e.target.value }))}
                placeholder="Email address"
              />
            </div>
            <div className="flex gap-2 pt-2">
              <Button variant="outline" className="flex-1" onClick={() => setEditingConnection(null)}>Cancel</Button>
              <Button
                className="flex-1"
                disabled={savingConnectionEdit}
                data-testid="button-save-connection-edit"
                onClick={handleSaveConnectionEdit}
              >
                {savingConnectionEdit ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Save className="w-4 h-4 mr-1" />}
                Save
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Admin: Delete Plaid Connection Confirm Dialog */}
      <Dialog open={!!deletingConnectionId} onOpenChange={(open) => !open && setDeletingConnectionId(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-600">
              <Trash2 className="w-4 h-4" />
              Delete Bank Connection
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground py-2">This will permanently remove this bank connection and its analysis data. This cannot be undone.</p>
          <div className="flex gap-2 pt-2">
            <Button variant="outline" className="flex-1" onClick={() => setDeletingConnectionId(null)}>Cancel</Button>
            <Button
              variant="destructive"
              className="flex-1"
              data-testid="button-confirm-delete-connection"
              onClick={() => deletingConnectionId && handleDeleteConnection(deletingConnectionId)}
            >
              <Trash2 className="w-4 h-4 mr-1" />
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Admin: Edit Bank Statement Upload Dialog */}
      <Dialog open={!!editingUpload} onOpenChange={(open) => !open && setEditingUpload(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="w-4 h-4" />
              Edit Statement Upload
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div>
              <Label>Business Name</Label>
              <Input
                data-testid="input-edit-upload-business"
                value={editUploadForm.businessName}
                onChange={(e) => setEditUploadForm(f => ({ ...f, businessName: e.target.value }))}
                placeholder="Business name"
              />
            </div>
            <div>
              <Label>Email</Label>
              <Input
                data-testid="input-edit-upload-email"
                value={editUploadForm.email}
                onChange={(e) => setEditUploadForm(f => ({ ...f, email: e.target.value }))}
                placeholder="Email address"
              />
            </div>
            <div className="flex gap-2 pt-2">
              <Button variant="outline" className="flex-1" onClick={() => setEditingUpload(null)}>Cancel</Button>
              <Button
                className="flex-1"
                disabled={savingUploadEdit}
                data-testid="button-save-upload-edit"
                onClick={handleSaveUploadEdit}
              >
                {savingUploadEdit ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Save className="w-4 h-4 mr-1" />}
                Save
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Admin: Delete Bank Statement Upload Confirm Dialog */}
      <Dialog open={!!deletingUploadId} onOpenChange={(open) => !open && setDeletingUploadId(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-600">
              <Trash2 className="w-4 h-4" />
              Delete Statement Upload
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground py-2">This will permanently remove this statement upload record. The file may still exist in storage. This cannot be undone.</p>
          <div className="flex gap-2 pt-2">
            <Button variant="outline" className="flex-1" onClick={() => setDeletingUploadId(null)}>Cancel</Button>
            <Button
              variant="destructive"
              className="flex-1"
              data-testid="button-confirm-delete-upload"
              onClick={() => deletingUploadId && handleDeleteUpload(deletingUploadId)}
            >
              <Trash2 className="w-4 h-4 mr-1" />
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Approval Form Dialog - For adding/editing a single approval */}
      <Dialog open={!!approvalFormDialog} onOpenChange={(open) => !open && setApprovalFormDialog(null)}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ThumbsUp className="w-5 h-5 text-green-600" />
              {approvalFormDialog?.editingApprovalId ? 'Edit' : 'Add'} Approval: {approvalFormDialog?.businessName}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-4">
            <div>
              <Label htmlFor="approval-assignedRep">Assigned Rep</Label>
              <Select
                value={approvalForm.assignedRep}
                onValueChange={(value) => setApprovalForm(prev => ({ ...prev, assignedRep: value === '__none__' ? '' : value }))}
              >
                <SelectTrigger id="approval-assignedRep" data-testid="select-approval-assigned-rep">
                  <SelectValue placeholder="Select rep (optional)" />
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
                <Label htmlFor="advanceAmount">Advance Amount</Label>
                <Input
                  id="advanceAmount"
                  type="number"
                  placeholder="$50,000"
                  value={approvalForm.advanceAmount}
                  onChange={(e) => setApprovalForm(prev => ({ ...prev, advanceAmount: e.target.value }))}
                  data-testid="input-advance-amount"
                />
              </div>
              <div>
                <Label htmlFor="term">Term</Label>
                <Input
                  id="term"
                  placeholder="6 months"
                  value={approvalForm.term}
                  onChange={(e) => setApprovalForm(prev => ({ ...prev, term: e.target.value }))}
                  data-testid="input-term"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="paymentFrequency">Payment Frequency</Label>
                <Select
                  value={approvalForm.paymentFrequency}
                  onValueChange={(value) => setApprovalForm(prev => ({ ...prev, paymentFrequency: value }))}
                >
                  <SelectTrigger data-testid="select-payment-frequency">
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
                <Label htmlFor="lender">Lender</Label>
                <Input
                  id="lender"
                  placeholder="Lender name"
                  value={approvalForm.lender}
                  onChange={(e) => setApprovalForm(prev => ({ ...prev, lender: e.target.value }))}
                  data-testid="input-lender"
                />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <Label htmlFor="factorRate">Factor Rate</Label>
                <Input
                  id="factorRate"
                  type="number"
                  step="0.01"
                  placeholder="1.25"
                  value={approvalForm.factorRate}
                  onChange={(e) => setApprovalForm(prev => ({ ...prev, factorRate: e.target.value }))}
                  data-testid="input-factor-rate"
                />
              </div>
              <div>
                <Label htmlFor="buyRate">Buy Rate</Label>
                <Input
                  id="buyRate"
                  type="number"
                  step="0.01"
                  placeholder="1.18"
                  value={approvalForm.buyRate}
                  onChange={(e) => setApprovalForm(prev => ({ ...prev, buyRate: e.target.value }))}
                  data-testid="input-buy-rate"
                />
              </div>
              <div>
                <Label htmlFor="sellRate">Sell Rate</Label>
                <Input
                  id="sellRate"
                  type="number"
                  step="0.01"
                  placeholder="1.25"
                  value={approvalForm.sellRate}
                  onChange={(e) => setApprovalForm(prev => ({ ...prev, sellRate: e.target.value }))}
                  data-testid="input-sell-rate"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="maxUpsell">Max Upsell (%)</Label>
                <div className="relative">
                  <Input
                    id="maxUpsell"
                    type="number"
                    step="1"
                    min="0"
                    max="100"
                    placeholder="20"
                    value={approvalForm.maxUpsell}
                    onChange={(e) => setApprovalForm(prev => ({ ...prev, maxUpsell: e.target.value }))}
                    data-testid="input-max-upsell"
                    className="pr-8"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm pointer-events-none">%</span>
                </div>
              </div>
            </div>
            <div>
              <Label>Approval Date</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    data-testid="input-approval-date"
                    className={cn("w-full justify-start text-left font-normal", !approvalForm.approvalDate && "text-muted-foreground")}
                  >
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {approvalForm.approvalDate ? format(new Date(approvalForm.approvalDate + 'T00:00:00'), "PPP") : "Pick a date"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0">
                  <Calendar
                    mode="single"
                    selected={approvalForm.approvalDate ? new Date(approvalForm.approvalDate + 'T00:00:00') : undefined}
                    onSelect={(day) => setApprovalForm(prev => ({ ...prev, approvalDate: day ? format(day, "yyyy-MM-dd") : '' }))}
                    fromYear={2024}
                    toYear={new Date().getFullYear()}
                    captionLayout="dropdown-buttons"
                    initialFocus
                  />
                </PopoverContent>
              </Popover>
            </div>
            <div>
              <Label htmlFor="notes">Notes</Label>
              <Textarea
                id="notes"
                placeholder="Additional notes..."
                rows={3}
                value={approvalForm.notes}
                onChange={(e) => setApprovalForm(prev => ({ ...prev, notes: e.target.value }))}
                data-testid="input-notes"
              />
            </div>
            <div className="flex justify-end gap-2 pt-4">
              <Button
                variant="outline"
                onClick={() => setApprovalFormDialog(null)}
                data-testid="button-cancel-approval"
              >
                Cancel
              </Button>
              <Button
                onClick={handleSaveApproval}
                disabled={savingDecision}
                className="bg-green-600 hover:bg-green-700"
                data-testid="button-save-approval"
              >
                {savingDecision ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Save className="w-4 h-4 mr-2" />
                    {approvalFormDialog?.editingApprovalId ? 'Update Approval' : 'Save Approval'}
                  </>
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Decline Dialog */}
      <Dialog open={!!declineDialog} onOpenChange={(open) => !open && setDeclineDialog(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ThumbsDown className="w-5 h-5 text-red-600" />
              Decline: {declineDialog?.businessName}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-4">
            <div>
              <Label htmlFor="decline-assignedRep">Assigned Rep</Label>
              <Select
                value={declineAssignedRep}
                onValueChange={(value) => setDeclineAssignedRep(value === '__none__' ? '' : value)}
              >
                <SelectTrigger id="decline-assignedRep" data-testid="select-decline-assigned-rep">
                  <SelectValue placeholder="Select rep (optional)" />
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
              <Label htmlFor="declineReason">Reason for Decline</Label>
              <Input
                id="declineReason"
                placeholder="Enter reason for declining..."
                value={declineReason}
                onChange={(e) => setDeclineReason(e.target.value)}
                data-testid="input-decline-reason"
              />
            </div>
            <div>
              <Label>Worth Following Up With?</Label>
              <div className="flex gap-2 mt-1">
                <Button
                  type="button"
                  size="sm"
                  variant={declineFollowUp ? "default" : "outline"}
                  onClick={() => setDeclineFollowUp(true)}
                  data-testid="button-decline-followup-yes"
                >
                  Yes
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={!declineFollowUp ? "default" : "outline"}
                  onClick={() => { setDeclineFollowUp(false); setDeclineFollowUpDate(''); }}
                  data-testid="button-decline-followup-no"
                >
                  No
                </Button>
              </div>
            </div>
            {declineFollowUp && (
              <div>
                <Label>Follow-Up Date</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      data-testid="input-decline-followup-date"
                      className={cn("w-full justify-start text-left font-normal", !declineFollowUpDate && "text-muted-foreground")}
                    >
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {declineFollowUpDate ? format(new Date(declineFollowUpDate + 'T00:00:00'), "PPP") : "Pick a date"}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0">
                    <Calendar
                      mode="single"
                      selected={declineFollowUpDate ? new Date(declineFollowUpDate + 'T00:00:00') : undefined}
                      onSelect={(day) => setDeclineFollowUpDate(day ? format(day, "yyyy-MM-dd") : '')}
                      fromYear={2024}
                      toYear={new Date().getFullYear() + 1}
                      captionLayout="dropdown-buttons"
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
              </div>
            )}
            <div className="flex justify-end gap-2 pt-4">
              <Button
                variant="outline"
                onClick={() => setDeclineDialog(null)}
                data-testid="button-cancel-decline"
              >
                Cancel
              </Button>
              <Button
                onClick={handleSaveDecline}
                disabled={savingDecision}
                className="bg-red-600 hover:bg-red-700"
                data-testid="button-save-decline"
              >
                {savingDecision ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <X className="w-4 h-4 mr-2" />
                    Decline Business
                  </>
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Unqualified Dialog */}
      <Dialog open={!!unqualifiedDialog} onOpenChange={(open) => !open && setUnqualifiedDialog(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertCircle className="w-5 h-5 text-orange-600" />
              Unqualified: {unqualifiedDialog?.businessName}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-4">
            <div>
              <Label htmlFor="unqualified-assignedRep">Assigned Rep</Label>
              <Select
                value={unqualifiedAssignedRep}
                onValueChange={(value) => setUnqualifiedAssignedRep(value === '__none__' ? '' : value)}
              >
                <SelectTrigger id="unqualified-assignedRep" data-testid="select-unqualified-assigned-rep">
                  <SelectValue placeholder="Select rep (optional)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">None</SelectItem>
                  {(agents || []).map(agent => (
                    <SelectItem key={agent.email} value={agent.name}>{agent.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <p className="text-sm text-muted-foreground">
              This applicant did not qualify to be sent out to lenders.
            </p>
            <div>
              <Label htmlFor="unqualifiedReason">Reason (Optional)</Label>
              <Input
                id="unqualifiedReason"
                placeholder="Enter reason for not qualifying..."
                value={unqualifiedReason}
                onChange={(e) => setUnqualifiedReason(e.target.value)}
                data-testid="input-unqualified-reason"
              />
            </div>
            <div>
              <Label>Worth Following Up With?</Label>
              <div className="flex gap-2 mt-1">
                <Button
                  type="button"
                  size="sm"
                  variant={unqualifiedFollowUp ? "default" : "outline"}
                  onClick={() => setUnqualifiedFollowUp(true)}
                  data-testid="button-unqualified-followup-yes"
                >
                  Yes
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={!unqualifiedFollowUp ? "default" : "outline"}
                  onClick={() => { setUnqualifiedFollowUp(false); setUnqualifiedFollowUpDate(''); }}
                  data-testid="button-unqualified-followup-no"
                >
                  No
                </Button>
              </div>
            </div>
            {unqualifiedFollowUp && (
              <div>
                <Label>Follow-Up Date</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      data-testid="input-unqualified-followup-date"
                      className={cn("w-full justify-start text-left font-normal", !unqualifiedFollowUpDate && "text-muted-foreground")}
                    >
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {unqualifiedFollowUpDate ? format(new Date(unqualifiedFollowUpDate + 'T00:00:00'), "PPP") : "Pick a date"}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0">
                    <Calendar
                      mode="single"
                      selected={unqualifiedFollowUpDate ? new Date(unqualifiedFollowUpDate + 'T00:00:00') : undefined}
                      onSelect={(day) => setUnqualifiedFollowUpDate(day ? format(day, "yyyy-MM-dd") : '')}
                      fromYear={2024}
                      toYear={new Date().getFullYear() + 1}
                      captionLayout="dropdown-buttons"
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
              </div>
            )}
            <div className="flex justify-end gap-2 pt-4">
              <Button
                variant="outline"
                onClick={() => setUnqualifiedDialog(null)}
                data-testid="button-cancel-unqualified"
              >
                Cancel
              </Button>
              <Button
                onClick={handleSaveUnqualified}
                disabled={savingDecision}
                className="bg-orange-600 hover:bg-orange-700"
                data-testid="button-save-unqualified"
              >
                {savingDecision ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <AlertCircle className="w-4 h-4 mr-2" />
                    Mark Unqualified
                  </>
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

// BotAttemptsTab imported from @/components/dashboard/BotAttemptsTab

export default function Dashboard() {
  const { toast } = useToast();
  const [searchTerm, setSearchTerm] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [additionalApps, setAdditionalApps] = useState<LoanApplication[]>([]);
  const [loadMoreOffset, setLoadMoreOffset] = useState(100);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [dashboardTab, setDashboardTab] = useState("applications");
  const [filterStatus, setFilterStatus_raw] = useState<"all" | "intake" | "full" | "partial" | "low-revenue">("all");
  const [currentPage, setCurrentPage] = useState(1);
  const ITEMS_PER_PAGE = 25;
  const setFilterStatus = (v: typeof filterStatus) => { setFilterStatus_raw(v); setCurrentPage(1); };
  const [selectedAgentFilter, setSelectedAgentFilter] = useState<string>("all");
  const [selectedAppDetails, setSelectedAppDetails] = useState<LoanApplication | null>(null);
  const [selectedAppForStatements, setSelectedAppForStatements] = useState<string | null>(null);
  const [isEditMode, setIsEditMode] = useState(false);
  const [editFormData, setEditFormData] = useState<Partial<LoanApplication>>({});
  const [resignApplication, setResignApplication] = useState(false);
  const [expandedSubmissions, setExpandedSubmissions] = useState<Set<string>>(new Set());
  const [expandedMerchants, setExpandedMerchants] = useState<Set<string>>(new Set());

  const { data: authData, isLoading: authLoading, refetch: refetchAuth } = useQuery<AuthState | null>({
    queryKey: ["/api/auth/check"],
    queryFn: getQueryFn({ on401: "returnNull" }),
  });

  // Unread merchant portal messages — badge on the Portal Messages nav item
  const { data: portalUnread } = useQuery<{ count: number } | null>({
    queryKey: ["/api/admin/merchant-messages/unread-count"],
    queryFn: getQueryFn({ on401: "returnNull" }),
    enabled: !!authData?.isAuthenticated && (authData.role === 'admin' || authData.role === 'underwriting'),
    refetchInterval: 60000,
  });
  const portalUnreadCount = portalUnread?.count || 0;

  // Debounce search: wait 400 ms after the user stops typing before hitting the server
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchTerm.trim()), 400);
    return () => clearTimeout(t);
  }, [searchTerm]);

  // Reset additional pages whenever search term changes
  useEffect(() => {
    setAdditionalApps([]);
    setLoadMoreOffset(100);
    setHasMore(false);
  }, [debouncedSearch]);

  // Reset merchant pagination whenever any filter changes (prevents stale rows mixing into results)
  useEffect(() => {
    setAdditionalMerchantGroups([]);
    setMerchantLoadMoreOffset(100);
    setHasMore(false);
  }, [debouncedSearch, filterStatus, selectedAgentFilter]);

  const { data: firstPageApps, isLoading: appsLoading } = useQuery<LoanApplication[]>({
    queryKey: ["/api/applications", debouncedSearch],
    enabled: authData?.isAuthenticated === true,
    queryFn: async () => {
      const url = debouncedSearch
        ? `/api/applications?search=${encodeURIComponent(debouncedSearch)}`
        : `/api/applications`;
      const res = await fetch(url, { credentials: "include" });
      if (res.status === 401) return [];
      if (!res.ok) throw new Error("Failed to fetch applications");
      const data: LoanApplication[] = await res.json();
      // Show "load more" only for admin/underwriting, no search active, exactly 100 records back
      setHasMore(!debouncedSearch && data.length === 100);
      return data;
    },
    retry: false,
    staleTime: 30_000, // cache for 30s so tab switching doesn't re-fetch constantly
  });

  // Merge first page + any additional pages loaded via "Load More"
  const applications = [...(firstPageApps ?? []), ...additionalApps];

  // Merchant-level groups from server (drives the card list — no pagination split problem)
  type MerchantGroup = { key: string; merchantId: string | null; businessName: string | null; primaryEmail: string | null; primaryPhone: string | null; apps: LoanApplication[]; latestActivity: string | null };
  const { data: merchantGroupsData, isLoading: merchantGroupsLoading } = useQuery<MerchantGroup[]>({
    queryKey: ["/api/merchants", debouncedSearch, filterStatus, selectedAgentFilter],
    enabled: authData?.isAuthenticated === true,
    queryFn: async () => {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (filterStatus && filterStatus !== "all") params.set("status", filterStatus);
      if (selectedAgentFilter && selectedAgentFilter !== "all") params.set("agent", selectedAgentFilter);
      const res = await fetch(`/api/merchants?${params}`, { credentials: "include" });
      if (res.status === 401) return [];
      if (!res.ok) throw new Error("Failed to fetch merchant groups");
      const data: MerchantGroup[] = await res.json();
      setHasMore(data.length === 100);
      return data;
    },
    retry: false,
    staleTime: 30_000,
  });

  const [additionalMerchantGroups, setAdditionalMerchantGroups] = useState<any[]>([]);
  const [merchantLoadMoreOffset, setMerchantLoadMoreOffset] = useState(100);

  const loadMore = async () => {
    setIsLoadingMore(true);
    try {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (filterStatus && filterStatus !== "all") params.set("status", filterStatus);
      if (selectedAgentFilter && selectedAgentFilter !== "all") params.set("agent", selectedAgentFilter);
      params.set("offset", String(merchantLoadMoreOffset));
      const res = await fetch(`/api/merchants?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      const data: any[] = await res.json();
      setAdditionalMerchantGroups(prev => [...prev, ...data]);
      setMerchantLoadMoreOffset(prev => prev + 100);
      setHasMore(data.length === 100);
    } catch {
      /* silently fail — user can try again */
    } finally {
      setIsLoadingMore(false);
    }
  };

  // Helper: invalidate first-page query AND clear accumulated extra pages
  const resetAndRefetch = () => {
    setAdditionalApps([]);
    setLoadMoreOffset(100);
    setAdditionalMerchantGroups([]);
    setMerchantLoadMoreOffset(100);
    setHasMore(false);
    queryClient.invalidateQueries({ queryKey: ["/api/applications"] });
    queryClient.invalidateQueries({ queryKey: ["/api/merchants"] });
  };


  const { data: bankUploads } = useQuery<BankStatementUpload[]>({
    queryKey: ['/api/bank-statements/uploads'],
    enabled: authData?.isAuthenticated === true,
    staleTime: 2 * 60 * 1000, // treat data as fresh for 2 min to avoid hammering the DB
    queryFn: async () => {
      const res = await fetch('/api/bank-statements/uploads', {
        credentials: 'include',
      });
      if (!res.ok) return [];
      return res.json();
    },
  });

  // Fetch underwriting decisions for pipeline status badges on application cards
  const { data: decisions } = useQuery<BusinessUnderwritingDecision[]>({
    queryKey: ["/api/underwriting-decisions"],
    enabled: authData?.isAuthenticated === true && (authData?.role === 'admin' || authData?.role === 'underwriting' || authData?.role === 'agent'),
    queryFn: async () => {
      const res = await fetch("/api/underwriting-decisions", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    retry: false,
  });

  // Build a lookup: email → highest-priority status (funded > approved > declined > unqualified)
  const pipelineStatusByEmail = new Map<string, { status: string; lender?: string; amount?: string }>();
  if (decisions) {
    for (const d of decisions) {
      const email = (d.businessEmail || d.merchantEmail || '').toLowerCase();
      if (!email) continue;
      const existing = pipelineStatusByEmail.get(email);
      const priority: Record<string, number> = { funded: 4, approved: 3, declined: 2, unqualified: 1 };
      const dStatus = d.fundedDate ? 'funded' : (d.status || 'unknown');
      if (!existing || (priority[dStatus] || 0) > (priority[existing.status] || 0)) {
        pipelineStatusByEmail.set(email, {
          status: dStatus,
          lender: d.lender || undefined,
          amount: d.advanceAmount || undefined,
        });
      }
    }
  }

  // Emails that already have at least one bank statement uploaded
  const emailsWithStatements = new Set<string>(
    (bankUploads || []).map(u => (u.email || '').toLowerCase()).filter(Boolean)
  );

  const logoutMutation = useMutation({
    mutationFn: async () => {
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "include",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/check"] });
      resetAndRefetch();
    },
  });

  const saveApplicationMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<LoanApplication> }) => {
      const res = await fetch(`/api/applications/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
        credentials: "include",
      });
      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || "Failed to save changes");
      }
      return res.json();
    },
    onSuccess: (updatedApp) => {
      // Update the selected app details with new data
      setSelectedAppDetails(updatedApp);
      setIsEditMode(false);
      // Refresh the applications list
      resetAndRefetch();
    },
  });

  const sendPortalLinkMutation = useMutation({
    mutationFn: async ({ applicationId, email }: { applicationId?: string; email?: string }) => {
      const res = await fetch("/api/merchant/send-portal-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ applicationId, email }),
        credentials: "include",
      });
      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || "Failed to send portal link");
      }
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Portal Link Sent",
        description: data.message || "Portal activation link has been emailed.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleLogout = () => {
    logoutMutation.mutate();
  };

  const [submittingUnderwritingApps, setSubmittingUnderwritingApps] = useState<Set<string>>(new Set());
  const [submittedUnderwritingApps, setSubmittedUnderwritingApps] = useState<Set<string>>(new Set());

  const handleSubmitAppToUnderwriting = async (email: string, businessName: string, appId: string) => {
    if (!email || submittingUnderwritingApps.has(appId)) return;
    setSubmittingUnderwritingApps(prev => new Set(prev).add(appId));
    try {
      const res = await fetch("/api/bank-statements/submit-to-underwriting", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, businessName }),
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || "Failed to submit"); }
      setSubmittedUnderwritingApps(prev => new Set(prev).add(appId));
      toast({ title: "Submitted to Underwriting", description: `underwriting@todaycapitalgroup.com has been notified for ${businessName}.` });
    } catch (err: any) {
      toast({ title: "Submission Failed", description: err.message, variant: "destructive" });
    } finally {
      setSubmittingUnderwritingApps(prev => { const s = new Set(prev); s.delete(appId); return s; });
    }
  };

  const handleEditClick = () => {
    if (selectedAppDetails) {
      setEditFormData({
        fullName: selectedAppDetails.fullName || "",
        email: selectedAppDetails.email || "",
        phone: selectedAppDetails.phone || "",
        dateOfBirth: selectedAppDetails.dateOfBirth || "",
        businessName: selectedAppDetails.businessName || "",
        legalBusinessName: selectedAppDetails.legalBusinessName || selectedAppDetails.businessName || "",
        doingBusinessAs: selectedAppDetails.doingBusinessAs || "",
        industry: selectedAppDetails.industry || "",
        ein: selectedAppDetails.ein || "",
        businessStartDate: selectedAppDetails.businessStartDate || "",
        stateOfIncorporation: selectedAppDetails.stateOfIncorporation || "",
        companyEmail: selectedAppDetails.companyEmail || "",
        companyWebsite: selectedAppDetails.companyWebsite || "",
        businessAddress: selectedAppDetails.businessStreetAddress || selectedAppDetails.businessAddress || "",
        city: selectedAppDetails.city || "",
        state: selectedAppDetails.state || "",
        zipCode: selectedAppDetails.zipCode || "",
        ownerAddress1: selectedAppDetails.ownerAddress1 || "",
        ownerAddress2: selectedAppDetails.ownerAddress2 || "",
        ownerCity: selectedAppDetails.ownerCity || "",
        ownerState: selectedAppDetails.ownerState || "",
        ownerZip: selectedAppDetails.ownerZip || "",
        requestedAmount: selectedAppDetails.requestedAmount || "",
        doYouProcessCreditCards: selectedAppDetails.doYouProcessCreditCards || "",
        ownership: selectedAppDetails.ownership || "",
        mcaBalanceAmount: selectedAppDetails.mcaBalanceAmount || "",
        mcaBalanceBankName: selectedAppDetails.mcaBalanceBankName || "",
        ficoScoreExact: selectedAppDetails.ficoScoreExact || selectedAppDetails.personalCreditScoreRange || "",
        socialSecurityNumber: selectedAppDetails.socialSecurityNumber || "",
      });
      setIsEditMode(true);
    }
  };

  const handleCancelEdit = () => {
    setIsEditMode(false);
    setEditFormData({});
    setResignApplication(false);
  };

  const handleSaveEdit = () => {
    if (selectedAppDetails?.id) {
      const dataToSave: Partial<LoanApplication> = { ...editFormData };
      // Convert empty strings to null so the server's filterEmptyValues passes them
      // through and the DB column is actually cleared (empty string gets dropped by
      // the filter, null does not).
      (Object.keys(dataToSave) as (keyof LoanApplication)[]).forEach((key) => {
        if ((dataToSave as any)[key] === "") {
          (dataToSave as any)[key] = null;
        }
      });
      if (resignApplication) {
        dataToSave.signatureDate = new Date().toISOString();
      }
      saveApplicationMutation.mutate({
        id: selectedAppDetails.id,
        data: dataToSave,
      });
      setResignApplication(false);
    }
  };

  const handleEditFieldChange = (field: string, value: string) => {
    setEditFormData(prev => ({ ...prev, [field]: value }));
  };

  const handleLoginSuccess = () => {
    refetchAuth();
    resetAndRefetch();
  };

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-[#192F56] to-[#19112D]">
        <div className="text-white text-lg">Loading...</div>
      </div>
    );
  }

  if (!authData?.isAuthenticated) {
    return <LoginForm onLoginSuccess={handleLoginSuccess} />;
  }

  // Extract unique agent names for the filter dropdown (admin only)
  const uniqueAgentNames = applications
    ? Array.from(new Set(applications.map(app => app.agentName).filter(Boolean)))
        .sort((a, b) => (a || "").localeCompare(b || ""))
    : [];

  const filteredApplications = applications
    ? applications
        .filter((app) => {
          // Search filtering is now server-side — client only handles status + agent filters

          // Parse monthly revenue for low-revenue filter
          const revenueStr = app.monthlyRevenue || app.averageMonthlyRevenue || "0";
          const revenueValue = typeof revenueStr === 'string' 
            ? parseFloat(revenueStr.replace(/[$,]/g, ''))
            : Number(revenueStr);
          const isLowRevenue = !isNaN(revenueValue) && revenueValue > 0 && revenueValue < 10000;

          const matchesFilter =
            (filterStatus === "all") ||
            (filterStatus === "intake" && app.isCompleted && !app.isFullApplicationCompleted && !isLowRevenue) ||
            (filterStatus === "full" && app.isFullApplicationCompleted && !isLowRevenue) ||
            (filterStatus === "partial" && !app.isCompleted && !app.isFullApplicationCompleted && !isLowRevenue) ||
            (filterStatus === "low-revenue" && isLowRevenue);

          // Agent filter (admin only feature)
          const matchesAgentFilter =
            selectedAgentFilter === "all" ||
            (selectedAgentFilter === "unassigned" && !app.agentName) ||
            (selectedAgentFilter === "web-leads" && !!(app as any).isWebLead) ||
            app.agentName === selectedAgentFilter;

          return matchesFilter && matchesAgentFilter;
        })
        .sort((a, b) => {
          // Most recent submission first (falls back to original creation date)
          const recencyA = (a as any).lastSubmissionAt || a.createdAt;
          const recencyB = (b as any).lastSubmissionAt || b.createdAt;
          const dateA = recencyA ? new Date(recencyA).getTime() : 0;
          const dateB = recencyB ? new Date(recencyB).getTime() : 0;
          return dateB - dateA;
        })
    : [];


  // Merchant groups driven by server-side query (correct grouping across all pages)
  // Merge first page + additional pages loaded via "Load More"
  const merchantGroups = [...(merchantGroupsData ?? []), ...additionalMerchantGroups];

  // Helper to check if app has low revenue
  const isAppLowRevenue = (app: LoanApplication) => {
    const revenueStr = app.monthlyRevenue || app.averageMonthlyRevenue || "0";
    const revenueValue = typeof revenueStr === 'string' 
      ? parseFloat(revenueStr.replace(/[$,]/g, ''))
      : Number(revenueStr);
    return !isNaN(revenueValue) && revenueValue > 0 && revenueValue < 10000;
  };

  const stats = {
    total: applications?.length || 0,
    intakeOnly: applications?.filter((a) => a.isCompleted && !a.isFullApplicationCompleted).length || 0,
    fullCompleted: applications?.filter((a) => a.isFullApplicationCompleted).length || 0,
    partial: applications?.filter((a) => !a.isCompleted && !a.isFullApplicationCompleted).length || 0,
    lowRevenue: applications?.filter(isAppLowRevenue).length || 0,
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="border-b bg-card">
        <div className="container mx-auto px-4 py-6">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div>
              <div className="flex items-center gap-3 mb-2 flex-wrap">
                <h1 className="text-3xl font-bold">
                  {authData.role === "admin" ? "Admin Dashboard" : authData.role === "user" ? "My Dashboard" : "Agent Dashboard"}
                </h1>
                {authData.role === "admin" ? (
                  <Badge variant="default" className="bg-primary" data-testid="badge-role-admin">
                    <Shield className="w-3 h-3 mr-1" />
                    Admin
                  </Badge>
                ) : authData.role === "user" ? (
                  <Badge variant="outline" data-testid="badge-role-user">
                    <User className="w-3 h-3 mr-1" />
                    User
                  </Badge>
                ) : (
                  <Badge variant="secondary" data-testid="badge-role-agent">
                    <User className="w-3 h-3 mr-1" />
                    Agent
                  </Badge>
                )}
              </div>
              <p className="text-muted-foreground">
                {authData.role === "admin" 
                  ? "Viewing all loan applications" 
                  : authData.role === "user"
                    ? `Viewing your submissions, ${authData.agentName}`
                    : `Viewing applications for ${authData.agentName}`}
              </p>
            </div>
            <div className="flex items-center gap-3">
              {(authData.role === 'admin' || authData.role === 'agent') && (
                <Link href="/upload-statements?internal=true">
                  <Button variant="outline" size="sm" data-testid="button-header-upload-statements">
                    <Upload className="w-4 h-4 mr-1.5" />
                    Upload Bank Statements
                  </Button>
                </Link>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="icon" data-testid="button-nav-menu">
                    <Menu className="w-5 h-5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel>Navigation</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <Link href="/dashboard">
                    <DropdownMenuItem className="cursor-pointer">
                      <FileText className="w-4 h-4 mr-2" />
                      Applications
                    </DropdownMenuItem>
                  </Link>
                  <Link href="/approvals">
                    <DropdownMenuItem className="cursor-pointer">
                      <ThumbsUp className="w-4 h-4 mr-2" />
                      Approved
                    </DropdownMenuItem>
                  </Link>
                  <Link href="/declines">
                    <DropdownMenuItem className="cursor-pointer">
                      <ThumbsDown className="w-4 h-4 mr-2" />
                      Declined
                    </DropdownMenuItem>
                  </Link>
                  <Link href="/unqualified">
                    <DropdownMenuItem className="cursor-pointer">
                      <AlertCircle className="w-4 h-4 mr-2" />
                      Unqualified
                    </DropdownMenuItem>
                  </Link>
                  <Link href="/funded">
                    <DropdownMenuItem className="cursor-pointer">
                      <Banknote className="w-4 h-4 mr-2" />
                      Funded
                    </DropdownMenuItem>
                  </Link>
                  <DropdownMenuSeparator />
                  {(authData.role === "admin" || authData.role === "agent") && (
                    <Link href="/merchant-profile">
                      <DropdownMenuItem className="cursor-pointer">
                        <Building2 className="w-4 h-4 mr-2" />
                        Merchant Profiles
                      </DropdownMenuItem>
                    </Link>
                  )}
                  {(authData.role === "admin" || authData.role === "agent") && (
                    <Link href="/rep-console">
                      <DropdownMenuItem className="cursor-pointer">
                        <User className="w-4 h-4 mr-2" />
                        Rep Console
                      </DropdownMenuItem>
                    </Link>
                  )}
                  {(authData.role === 'admin' || authData.role === 'underwriting') && (
                    <Link href="/messaging">
                      <DropdownMenuItem className="cursor-pointer">
                        <MessageSquare className="w-4 h-4 mr-2" />
                        Messaging
                      </DropdownMenuItem>
                    </Link>
                  )}
                  {(authData.role === 'admin' || authData.role === 'underwriting') && (
                    <Link href="/portal-messages">
                      <DropdownMenuItem className="cursor-pointer">
                        <MessageSquare className="w-4 h-4 mr-2" />
                        Portal Messages
                        {portalUnreadCount > 0 && (
                          <span className="ml-auto inline-flex items-center justify-center rounded-full bg-primary text-primary-foreground text-[10px] font-bold h-5 min-w-5 px-1.5">
                            {portalUnreadCount}
                          </span>
                        )}
                      </DropdownMenuItem>
                    </Link>
                  )}
                  {authData.role === 'admin' && (
                    <Link href="/sms-inbox">
                      <DropdownMenuItem className="cursor-pointer">
                        <Phone className="w-4 h-4 mr-2" />
                        SMS Inbox
                      </DropdownMenuItem>
                    </Link>
                  )}
                  {authData.role === 'admin' && (
                    <Link href="/triggers">
                      <DropdownMenuItem className="cursor-pointer">
                        <Bot className="w-4 h-4 mr-2" />
                        Auto Follow-ups
                      </DropdownMenuItem>
                    </Link>
                  )}
                  {(authData.role === 'admin' || authData.role === 'underwriting') && (
                    <Link href="/lead-sources">
                      <DropdownMenuItem className="cursor-pointer">
                        <BarChart3 className="w-4 h-4 mr-2" />
                        Lead Sources
                      </DropdownMenuItem>
                    </Link>
                  )}
                  <Link href="/leaderboard">
                    <DropdownMenuItem className="cursor-pointer">
                      <Trophy className="w-4 h-4 mr-2" />
                      Leaderboard
                    </DropdownMenuItem>
                  </Link>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="cursor-pointer text-red-600 dark:text-red-400"
                    onClick={handleLogout}
                    disabled={logoutMutation.isPending}
                  >
                    <LogOut className="w-4 h-4 mr-2" />
                    {logoutMutation.isPending ? "Logging out..." : "Logout"}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </div>
      </div>

      <div className="container mx-auto px-4 py-8">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
          <Card className="p-6" data-testid="card-stat-total">
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-sm text-muted-foreground mb-1">
                  {authData.role === "admin" ? "Total Applications" : "Your Applications"}
                </p>
                <p className="text-3xl font-bold" data-testid="text-total-count">{stats.total}</p>
              </div>
              <div className="w-12 h-12 bg-primary/10 rounded-lg flex items-center justify-center">
                <Clock className="w-6 h-6 text-primary" />
              </div>
            </div>
          </Card>

          <Card className="p-6" data-testid="card-stat-intake">
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-sm text-muted-foreground mb-1">Intake Only</p>
                <p className="text-3xl font-bold" data-testid="text-intake-count">{stats.intakeOnly}</p>
              </div>
              <div className="w-12 h-12 bg-orange-500/10 rounded-lg flex items-center justify-center">
                <Filter className="w-6 h-6 text-orange-500" />
              </div>
            </div>
          </Card>

          <Card className="p-6" data-testid="card-stat-full">
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-sm text-muted-foreground mb-1">Full Applications</p>
                <p className="text-3xl font-bold" data-testid="text-full-count">{stats.fullCompleted}</p>
              </div>
              <div className="w-12 h-12 bg-green-500/10 rounded-lg flex items-center justify-center">
                <CheckCircle2 className="w-6 h-6 text-green-500" />
              </div>
            </div>
          </Card>

        </div>

        <Tabs value={dashboardTab} onValueChange={setDashboardTab} className="w-full">
          <div className="flex flex-col gap-4 mb-6">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
              <div className="flex flex-wrap items-center gap-2">
                <TabsList data-testid="tabs-dashboard">
                  <TabsTrigger value="applications" data-testid="tab-applications">
                    <FileText className="w-4 h-4 mr-2" />
                    Applications
                  </TabsTrigger>
                  <TabsTrigger value="bank-statements" data-testid="tab-bank-statements">
                    <Landmark className="w-4 h-4 mr-2" />
                    Bank Statements
                  </TabsTrigger>
                </TabsList>
                {(authData?.role === 'admin' || authData?.role === 'underwriting' || authData?.role === 'agent') && (
                  <>
                    {/* Pipeline status views */}
                    <div className="hidden md:flex items-center gap-1 ml-1 pl-2 border-l border-gray-200 dark:border-gray-700">
                      <Link href="/approvals">
                        <Button variant="ghost" size="sm" data-testid="button-approvals-folder" className="text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/30">
                          <ThumbsUp className="w-4 h-4 mr-1.5" />Approved
                        </Button>
                      </Link>
                      <Link href="/declines">
                        <Button variant="ghost" size="sm" data-testid="button-declined-folder" className="text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30">
                          <ThumbsDown className="w-4 h-4 mr-1.5" />Declined
                        </Button>
                      </Link>
                      <Link href="/unqualified">
                        <Button variant="ghost" size="sm" data-testid="button-unqualified-folder" className="text-orange-700 dark:text-orange-400 hover:bg-orange-50 dark:hover:bg-orange-950/30">
                          <AlertCircle className="w-4 h-4 mr-1.5" />Unqualified
                        </Button>
                      </Link>
                      <Link href="/funded">
                        <Button variant="ghost" size="sm" data-testid="button-funded-folder" className="text-purple-700 dark:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-950/30">
                          <Banknote className="w-4 h-4 mr-1.5" />Funded
                        </Button>
                      </Link>
                    </div>
                    {/* Tools */}
                    <div className="hidden md:flex items-center gap-1 pl-2 border-l border-gray-200 dark:border-gray-700">
                      <Link href="/my-leads">
                        <Button variant="ghost" size="sm" className="text-violet-700 dark:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-950/30">
                          <Target className="w-4 h-4 mr-1.5" />My Leads
                        </Button>
                      </Link>
                      <Link href="/renewal-pipeline">
                        <Button variant="ghost" size="sm" className="text-orange-700 dark:text-orange-400 hover:bg-orange-50 dark:hover:bg-orange-950/30">
                          <TrendingUp className="w-4 h-4 mr-1.5" />Renewals
                        </Button>
                      </Link>
                      <Link href="/messaging">
                        <Button variant="ghost" size="sm" data-testid="button-messaging" className="text-sky-700 dark:text-sky-400 hover:bg-sky-50 dark:hover:bg-sky-950/30">
                          <Mail className="w-4 h-4 mr-1.5" />Messaging
                        </Button>
                      </Link>
                    </div>
                    {/* Mobile: collapsed dropdown for pipeline views */}
                    <div className="md:hidden">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="outline" size="sm">
                            <Menu className="w-4 h-4 mr-1.5" />Pipeline
                            <ChevronDown className="w-3 h-3 ml-1" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start">
                          <DropdownMenuItem onClick={() => window.location.href = '/approvals'}>
                            <ThumbsUp className="w-4 h-4 mr-2 text-emerald-600" />Approved
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => window.location.href = '/declines'}>
                            <ThumbsDown className="w-4 h-4 mr-2 text-red-600" />Declined
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => window.location.href = '/unqualified'}>
                            <AlertCircle className="w-4 h-4 mr-2 text-orange-600" />Unqualified
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => window.location.href = '/funded'}>
                            <Banknote className="w-4 h-4 mr-2 text-purple-600" />Funded
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => window.location.href = '/my-leads'}>
                            <Target className="w-4 h-4 mr-2 text-violet-600" />My Leads
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => window.location.href = '/renewal-pipeline'}>
                            <TrendingUp className="w-4 h-4 mr-2 text-orange-600" />Renewals
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => window.location.href = '/messaging'}>
                            <Mail className="w-4 h-4 mr-2 text-sky-600" />Messaging
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </>
                )}
              </div>
              <div className="flex gap-2 w-full md:w-auto">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      data-testid="button-download-template"
                      className="flex-1 md:flex-none"
                    >
                      <Download className="w-4 h-4 mr-2" />
                      Download Template
                      <ChevronDown className="w-3 h-3 ml-2" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuLabel>Select Template Type</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      data-testid="template-standard"
                      onClick={() => window.open("/api/application-template?type=standard", "_blank")}
                    >
                      <FileText className="w-4 h-4 mr-2" />
                      Standard
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      data-testid="template-signature"
                      onClick={() => window.open("/api/application-template?type=signature", "_blank")}
                    >
                      <FileEdit className="w-4 h-4 mr-2" />
                      Signature
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      data-testid="template-lcg"
                      onClick={() => window.open("/api/application-template?type=lcg", "_blank")}
                    >
                      <FileText className="w-4 h-4 mr-2" />
                      LCG
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      data-testid="template-redacted"
                      onClick={() => window.open("/api/application-template?type=redacted", "_blank")}
                    >
                      <Lock className="w-4 h-4 mr-2" />
                      Redacted
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button
                  variant="outline"
                  onClick={() => window.open("/api/applications/export/csv", "_blank")}
                  data-testid="button-export-csv"
                  className="flex-1 md:flex-none"
                >
                  <FileText className="w-4 h-4 mr-2" />
                  Export CSV
                </Button>
                {(authData?.role === 'admin' || authData?.role === 'underwriting' || authData?.role === 'agent') && (
                  <Link href="/merchant-profile">
                    <Button variant="outline" data-testid="tab-merchant-profiles">
                      <Building2 className="w-4 h-4 mr-2" />
                      Merchant Profiles
                    </Button>
                  </Link>
                )}
              </div>
            </div>
          </div>

          <TabsContent value="applications">
            <Card className="p-6 mb-6">
          <div className="flex flex-col md:flex-row gap-4">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground w-4 h-4" />
              <Input
                placeholder="Search by name, email, or business..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10"
                data-testid="input-search-applications"
              />
            </div>
            <div className="flex gap-2 flex-wrap items-center">
              <Button
                variant={filterStatus === "all" ? "default" : "outline"}
                onClick={() => setFilterStatus("all")}
                data-testid="button-filter-all"
              >
                All
              </Button>
              <Button
                variant={filterStatus === "intake" ? "default" : "outline"}
                onClick={() => setFilterStatus("intake")}
                data-testid="button-filter-intake"
              >
                Intake Only
              </Button>
              <Button
                variant={filterStatus === "full" ? "default" : "outline"}
                onClick={() => setFilterStatus("full")}
                data-testid="button-filter-full"
              >
                Full App
              </Button>
              <Button
                variant={filterStatus === "partial" ? "default" : "outline"}
                onClick={() => setFilterStatus("partial")}
                data-testid="button-filter-partial"
              >
                Partial
              </Button>
              <Button
                variant={filterStatus === "low-revenue" ? "default" : "outline"}
                onClick={() => setFilterStatus("low-revenue")}
                data-testid="button-filter-low-revenue"
                className={filterStatus === "low-revenue" ? "bg-amber-600 hover:bg-amber-700" : ""}
              >
                <TrendingDown className="w-4 h-4 mr-1" />
                Low Revenue ({stats.lowRevenue})
              </Button>
              {authData.role === "admin" && uniqueAgentNames.length > 0 && (
                <Select
                  value={selectedAgentFilter}
                  onValueChange={setSelectedAgentFilter}
                >
                  <SelectTrigger className="w-[180px]" data-testid="select-agent-filter">
                    <SelectValue placeholder="Filter by Agent" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Agents</SelectItem>
                    <SelectItem value="unassigned">Unassigned</SelectItem>
                    <SelectItem value="web-leads">Web Leads</SelectItem>
                    {uniqueAgentNames.map((agentName) => (
                      <SelectItem key={agentName} value={agentName || ""}>
                        {agentName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          </div>
        </Card>


        {(appsLoading || merchantGroupsLoading) ? (
          <Card className="p-12" data-testid="card-loading-state">
            <p className="text-center text-muted-foreground" data-testid="text-loading-message">Loading applications...</p>
          </Card>
        ) : merchantGroups.length > 0 ? (
          <div className="space-y-2">
            {merchantGroups.slice((currentPage - 1) * ITEMS_PER_PAGE, currentPage * ITEMS_PER_PAGE).map(({ key, apps: groupApps }) => {
              const app = groupApps[0];
              const otherRounds = groupApps.slice(1);
              const isMerchantExpanded = expandedMerchants.has(key);
              return (
              <Card key={key} className="p-4 hover-elevate" data-testid={`card-application-${app.id}`}>
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <h3 className="font-semibold text-lg flex items-center gap-1" data-testid={`text-business-name-${app.id}`}>
                        {app.legalBusinessName || app.businessName || "No business name"}
                        {Number(app.monthlyRevenue || app.averageMonthlyRevenue) >= 20000 && (
                          <Star className="w-4 h-4 text-yellow-500 fill-yellow-500" data-testid={`icon-high-revenue-${app.id}`} />
                        )}
                      </h3>
                      {app.isFullApplicationCompleted ? (
                        <Badge variant="default" className="bg-green-600 hover:bg-green-700" data-testid={`badge-status-full-${app.id}`}>
                          <CheckCircle2 className="w-3 h-3 mr-1" />
                          Full App
                        </Badge>
                      ) : app.isCompleted ? (
                        <Badge variant="secondary" data-testid={`badge-status-intake-${app.id}`}>
                          <Clock className="w-3 h-3 mr-1" />
                          Intake Only
                        </Badge>
                      ) : (
                        <Badge variant="outline" data-testid={`badge-status-incomplete-${app.id}`}>Incomplete</Badge>
                      )}
                      {/* Pipeline status from underwriting decisions */}
                      {app.email && pipelineStatusByEmail.get(app.email.toLowerCase()) && (() => {
                        const ps = pipelineStatusByEmail.get(app.email.toLowerCase())!;
                        if (ps.status === 'funded') return (
                          <Badge className="bg-green-600 text-[10px]" data-testid={`badge-pipeline-${app.id}`}>
                            <Banknote className="w-3 h-3 mr-1" />
                            Funded{ps.amount ? ` · $${Number(ps.amount).toLocaleString()}` : ''}
                          </Badge>
                        );
                        if (ps.status === 'approved') return (
                          <Badge className="bg-blue-600 text-[10px]" data-testid={`badge-pipeline-${app.id}`}>
                            <ThumbsUp className="w-3 h-3 mr-1" />
                            Approved{ps.lender ? ` · ${ps.lender}` : ''}
                          </Badge>
                        );
                        if (ps.status === 'declined') return (
                          <Badge variant="destructive" className="text-[10px]" data-testid={`badge-pipeline-${app.id}`}>
                            <ThumbsDown className="w-3 h-3 mr-1" />
                            Declined
                          </Badge>
                        );
                        if (ps.status === 'unqualified') return (
                          <Badge variant="outline" className="text-[10px] border-orange-400 text-orange-500" data-testid={`badge-pipeline-${app.id}`}>
                            <AlertCircle className="w-3 h-3 mr-1" />
                            Unqualified
                          </Badge>
                        );
                        return null;
                      })()}
                      {authData.role === "admin" && app.agentName && (
                        // agentEmail is only ever set by the rep application flow;
                        // GHL owner lookup sets agentName without an email — style
                        // those to show the assignment came from GHL.
                        app.agentEmail ? (
                          <Badge variant="outline" className="text-xs" data-testid={`badge-agent-${app.id}`}>
                            <User className="w-3 h-3 mr-1" />
                            {app.agentName}
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-xs border-violet-400 text-violet-600 dark:text-violet-400 dark:border-violet-700" title="Rep assigned from GHL contact owner" data-testid={`badge-agent-${app.id}`}>
                            <User className="w-3 h-3 mr-1" />
                            {app.agentName} · GHL
                          </Badge>
                        )
                      )}
                      {(app as any).sourcePage && (
                        <Badge variant="outline" className="text-xs border-amber-400 text-amber-600 dark:text-amber-400 dark:border-amber-700" title="Site this application came from" data-testid={`badge-source-${app.id}`}>
                          <Globe className="w-3 h-3 mr-1" />
                          via {String((app as any).sourcePage).split("-").map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")}
                        </Badge>
                      )}
                      {authData.role === "admin" && (app as any).referralPartnerName && (
                        <Badge variant="outline" className="text-xs border-blue-400 text-blue-600 dark:text-blue-400" data-testid={`badge-partner-${app.id}`}>
                          <User className="w-3 h-3 mr-1" />
                          {(app as any).referralPartnerName}
                        </Badge>
                      )}
                    </div>
                    
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-1 text-sm text-muted-foreground">
                      <div className="flex items-center gap-1">
                        <span className="font-medium">Email:</span>{" "}
                        <span data-testid={`value-email-${app.id}`}>{app.email || "N/A"}</span>
                        {app.email && (
                          <button
                            className="ml-1 text-muted-foreground hover:text-primary transition-colors"
                            title="Copy email"
                            onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(app.email); toast({ title: "Copied", description: app.email }); }}
                          >
                            <Copy className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                      <div>
                        <span className="font-medium">Contact:</span>{" "}
                        <span data-testid={`value-contact-${app.id}`}>{app.fullName || "N/A"}</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <span className="font-medium">Phone:</span>{" "}
                        <span data-testid={`value-phone-${app.id}`}>{app.phone || "N/A"}</span>
                        {app.phone && (
                          <button
                            className="ml-1 text-muted-foreground hover:text-primary transition-colors"
                            title="Copy phone"
                            onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(app.phone!); toast({ title: "Copied", description: app.phone }); }}
                          >
                            <Copy className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                      <div>
                        <span className="font-medium">Submitted:</span>{" "}
                        <span data-testid={`value-submitted-${app.id}`}>{(() => {
                          const latest = (app as any).lastSubmissionAt || app.createdAt;
                          return latest ? format(new Date(latest), "MMM d, yyyy h:mm a") : "N/A";
                        })()}</span>
                      </div>
                      {app.requestedAmount && (
                        <div>
                          <span className="font-medium">Amount:</span>{" "}
                          <span data-testid={`value-amount-${app.id}`}>${Number(app.requestedAmount).toLocaleString()}</span>
                        </div>
                      )}
                      {app.industry && (
                        <div>
                          <span className="font-medium">Industry:</span>{" "}
                          <span data-testid={`value-industry-${app.id}`}>{app.industry}</span>
                        </div>
                      )}
                      {(app.monthlyRevenue || app.averageMonthlyRevenue) && Number(app.monthlyRevenue || app.averageMonthlyRevenue) > 0 && (
                        <div className="flex items-center gap-1">
                          <span className="font-medium">Revenue:</span>{" "}
                          <span data-testid={`value-revenue-${app.id}`}>
                            ${Number(app.monthlyRevenue || app.averageMonthlyRevenue).toLocaleString()}/mo
                          </span>
                          {Number(app.monthlyRevenue || app.averageMonthlyRevenue) >= 20000 && (
                            <Star className="w-3 h-3 text-yellow-500 fill-yellow-500" />
                          )}
                        </div>
                      )}
                      {app.useOfFunds && (
                        <div>
                          <span className="font-medium">Use of Funds:</span>{" "}
                          <span data-testid={`value-use-of-funds-${app.id}`} className="truncate max-w-[200px] inline-block align-bottom" title={app.useOfFunds}>
                            {app.useOfFunds.length > 30 ? app.useOfFunds.slice(0, 30) + "..." : app.useOfFunds}
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Submission history dropdown — shown when the file has multiple submissions */}
                    {(() => {
                      const submissions = (((app as any).submissions || []) as { id: string; submissionType: string; createdAt: string | null; requestedAmount: string | null }[]);
                      if (submissions.length <= 1) return null;
                      const isExpanded = expandedSubmissions.has(app.id);
                      return (
                        <div className="mt-2">
                          <button
                            onClick={() => setExpandedSubmissions(prev => {
                              const next = new Set(prev);
                              if (next.has(app.id)) next.delete(app.id); else next.add(app.id);
                              return next;
                            })}
                            className="flex items-center gap-1 text-sm text-primary hover:underline"
                            data-testid={`button-toggle-submissions-${app.id}`}
                          >
                            {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                            {isExpanded ? 'Hide' : 'View'} {submissions.length} Submissions
                          </button>
                          {isExpanded && (
                            <div className="mt-2 space-y-1 border-l-2 border-muted pl-3">
                              {submissions.map((s) => (
                                <div key={s.id} className="flex items-center gap-2 text-sm text-muted-foreground" data-testid={`submission-${s.id}`}>
                                  <Badge variant={s.submissionType === 'full_application' ? 'default' : 'secondary'} className="text-[10px]">
                                    {s.submissionType === 'full_application' ? 'Full App' : 'Intake'}
                                  </Badge>
                                  <span>{s.createdAt ? format(new Date(s.createdAt), "MMM d, yyyy h:mm a") : 'Unknown date'}</span>
                                  {s.requestedAmount && Number(s.requestedAmount) > 0 && (
                                    <span>· ${Number(s.requestedAmount).toLocaleString()} requested</span>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setSelectedAppDetails(app)}
                      data-testid={`button-view-details-${app.id}`}
                    >
                      <Search className="w-4 h-4 mr-2" />
                      View Details
                    </Button>
                    <Button
                      variant="default"
                      size="sm"
                      onClick={() => window.open(`/agent/application/${app.id}`, "_blank")}
                      data-testid={`button-view-application-${app.id}`}
                    >
                      <ExternalLink className="w-4 h-4 mr-2" />
                      View Application
                    </Button>
                    {app.email && (
                      <>
                        <Link href={`/merchant-profile/${encodeURIComponent(app.email)}`}>
                          <Button
                            variant="outline"
                            size="sm"
                            className="w-full"
                            data-testid={`button-view-profile-${app.id}`}
                          >
                            <Building2 className="w-4 h-4 mr-2" />
                            Merchant Profile
                          </Button>
                        </Link>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => sendPortalLinkMutation.mutate({ applicationId: app.id, email: app.email || undefined })}
                          disabled={sendPortalLinkMutation.isPending}
                          data-testid={`button-send-portal-link-${app.id}`}
                        >
                          <Mail className="w-4 h-4 mr-2" />
                          {sendPortalLinkMutation.isPending ? "Sending..." : "Send Portal Link"}
                        </Button>
                      </>
                    )}
                    {authData.role === "admin" && app.email && (() => {
                      const bizEmail = app.email.toLowerCase();
                      const bizName = app.legalBusinessName || app.businessName || "";
                      const existingDecision = pipelineStatusByEmail.get(bizEmail);
                      if (existingDecision) {
                        return (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              // Decision dialogs live on the Bank Statements tab — jump there
                              setDashboardTab("bank-statements");
                            }}
                            className="text-muted-foreground w-full"
                            data-testid={`button-edit-decision-app-${app.id}`}
                          >
                            <Pencil className="w-3 h-3 mr-1" />
                            Edit Decision
                          </Button>
                        );
                      }
                      return null;
                    })()}
                    <p className="text-xs text-muted-foreground text-center" data-testid={`text-app-id-${app.id}`}>ID: {app.id?.slice(0, 8)}...</p>
                  </div>
                </div>
                {authData.role === "admin" && app.email && (() => {
                  const bizEmail = app.email.toLowerCase();
                  const bizName = app.legalBusinessName || app.businessName || "";
                  const existingDecision = pipelineStatusByEmail.get(bizEmail);
                  if (existingDecision) return null;
                  return (
                    <div className="flex gap-2 pt-3 mt-2 border-t border-border flex-wrap" data-testid={`div-quick-actions-${app.id}`}>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setDashboardTab("bank-statements")}
                        className="flex-1 text-green-600 border-green-200 hover:bg-green-50 dark:border-green-800 dark:hover:bg-green-900/20"
                        data-testid={`button-approve-app-${app.id}`}
                      >
                        <ThumbsUp className="w-3 h-3 mr-1" />
                        Approve
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setDashboardTab("bank-statements")}
                        className="flex-1 text-red-600 border-red-200 hover:bg-red-50 dark:border-red-800 dark:hover:bg-red-900/20"
                        data-testid={`button-decline-app-${app.id}`}
                      >
                        <ThumbsDown className="w-3 h-3 mr-1" />
                        Decline
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setDashboardTab("bank-statements")}
                        className="flex-1 text-orange-600 border-orange-200 hover:bg-orange-50 dark:border-orange-800 dark:hover:bg-orange-900/20"
                        data-testid={`button-unqualified-app-${app.id}`}
                      >
                        <AlertCircle className="w-3 h-3 mr-1" />
                        Unqualified
                      </Button>
                    </div>
                  );
                })()}
                {(authData.role === 'admin' || authData.role === 'agent') && app.email && (
                  <div className="pt-2 mt-2 border-t border-border flex gap-2" data-testid={`div-upload-statements-${app.id}`}>
                    <Link href={`/upload-statements?internal=true&email=${encodeURIComponent(app.email)}&businessName=${encodeURIComponent(app.legalBusinessName || app.businessName || '')}`} className="flex-1">
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full text-blue-600 border-blue-200 dark:border-blue-800"
                        data-testid={`button-upload-statements-${app.id}`}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Upload className="w-3 h-3 mr-1" />
                        Upload Statements
                      </Button>
                    </Link>
                    {(() => {
                      const appUwDate = app.uwSubmittedAt ? new Date(app.uwSubmittedAt) : null;
                      const appWasSubmitted = submittedUnderwritingApps.has(app.id) || !!appUwDate;
                      const appSubmittedLabel = appUwDate
                        ? `Submitted ${appUwDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
                        : 'Submitted';
                      return (
                        <Button
                          variant="outline"
                          size="sm"
                          className={`flex-1 ${appWasSubmitted ? "text-amber-600 border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-400" : "text-green-600 border-green-200 dark:border-green-800"}`}
                          data-testid={`button-submit-underwriting-app-${app.id}`}
                          disabled={submittingUnderwritingApps.has(app.id) || appWasSubmitted}
                          onClick={(e) => { e.stopPropagation(); handleSubmitAppToUnderwriting(app.email!, app.legalBusinessName || app.businessName || '', app.id); }}
                        >
                          {submittingUnderwritingApps.has(app.id) ? (
                            <><Loader2 className="w-3 h-3 mr-1 animate-spin" />Submitting…</>
                          ) : appWasSubmitted ? (
                            <><CheckCircle2 className="w-3 h-3 mr-1" />{appSubmittedLabel}</>
                          ) : (
                            <><Send className="w-3 h-3 mr-1" />Submit to UW</>
                          )}
                        </Button>
                      );
                    })()}
                  </div>
                )}

                {/* Other application rounds for this merchant */}
                {otherRounds.length > 0 && (
                  <div className="mt-3 pt-3 border-t">
                    <button
                      data-testid={`button-toggle-rounds-${app.id}`}
                      onClick={() => setExpandedMerchants(prev => {
                        const next = new Set(prev);
                        if (next.has(key)) next.delete(key); else next.add(key);
                        return next;
                      })}
                      className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {isMerchantExpanded ? (
                        <ChevronUp className="w-3 h-3" />
                      ) : (
                        <ChevronDown className="w-3 h-3" />
                      )}
                      {otherRounds.length} older round{otherRounds.length > 1 ? "s" : ""}
                    </button>
                    {isMerchantExpanded && (
                      <div className="mt-2 space-y-1 pl-1" data-testid={`div-other-rounds-${app.id}`}>
                        {otherRounds.map((r: any) => (
                          <div key={r.id} className="flex items-center justify-between gap-2 py-1 text-sm border-b last:border-0">
                            <div className="flex flex-col min-w-0">
                              <span className="text-muted-foreground text-xs">
                                {r.createdAt ? new Date(r.createdAt).toLocaleDateString() : "—"}
                                {(r as any).agentName && (
                                  <span className="ml-2 opacity-70">{(r as any).agentName}</span>
                                )}
                              </span>
                              {((r as any).requestedAmount) && (
                                <span className="text-xs font-medium">
                                  ${Number((r as any).requestedAmount).toLocaleString()}
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-2 flex-shrink-0">
                              <Badge variant="outline" className="text-xs" data-testid={`badge-round-status-${r.id}`}>
                                {r.isFullApplicationCompleted ? "Full App" : r.isCompleted ? "Intake" : "Partial"}
                              </Badge>
                              <a
                                href={`/agent/application/${r.id}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs text-blue-600 hover:underline"
                                data-testid={`link-round-view-${r.id}`}
                              >
                                View
                              </a>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </Card>
              );
            })}

            {/* Load more */}
            {hasMore && (
              <div className="flex justify-center pt-2 pb-4" data-testid="div-load-more">
                <Button
                  variant="outline"
                  onClick={loadMore}
                  disabled={isLoadingMore}
                  data-testid="button-load-more"
                >
                  {isLoadingMore ? "Loading..." : "Load more applications"}
                </Button>
              </div>
            )}
            {!hasMore && applications.length > 100 && (
              <p className="text-center text-xs text-muted-foreground py-3" data-testid="text-all-loaded">
                All {applications.length} applications loaded — use search to filter further.
              </p>
            )}
            {/* Pagination controls */}
            {merchantGroups.length > ITEMS_PER_PAGE && (
              <div className="flex items-center justify-between pt-4 border-t mt-2">
                <p className="text-sm text-muted-foreground">
                  Showing {Math.min((currentPage - 1) * ITEMS_PER_PAGE + 1, merchantGroups.length)}-{Math.min(currentPage * ITEMS_PER_PAGE, merchantGroups.length)} of {merchantGroups.length}
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={currentPage <= 1}
                    onClick={() => { setCurrentPage(p => Math.max(1, p - 1)); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
                  >
                    Previous
                  </Button>
                  {Array.from({ length: Math.min(5, Math.ceil(merchantGroups.length / ITEMS_PER_PAGE)) }, (_, i) => {
                    const totalPages = Math.ceil(merchantGroups.length / ITEMS_PER_PAGE);
                    let pageNum: number;
                    if (totalPages <= 5) {
                      pageNum = i + 1;
                    } else if (currentPage <= 3) {
                      pageNum = i + 1;
                    } else if (currentPage >= totalPages - 2) {
                      pageNum = totalPages - 4 + i;
                    } else {
                      pageNum = currentPage - 2 + i;
                    }
                    return (
                      <Button
                        key={pageNum}
                        variant={currentPage === pageNum ? "default" : "outline"}
                        size="sm"
                        className="w-9"
                        onClick={() => { setCurrentPage(pageNum); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
                      >
                        {pageNum}
                      </Button>
                    );
                  })}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={currentPage >= Math.ceil(merchantGroups.length / ITEMS_PER_PAGE)}
                    onClick={() => { setCurrentPage(p => p + 1); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <Card className="p-12" data-testid="card-empty-state">
            <p className="text-center text-muted-foreground" data-testid="text-empty-message">
              {searchTerm || filterStatus !== "all" 
                ? "No applications match your filters" 
                : authData.role === "agent" 
                  ? "No applications submitted through your link yet"
                  : "No applications yet"}
            </p>
          </Card>
        )}
          </TabsContent>

          <TabsContent value="bank-statements">
            <BankStatementsTab applications={applications} />
          </TabsContent>

        </Tabs>
      </div>

      <StatementsModal
        applicationId={selectedAppForStatements || ''}
        isOpen={!!selectedAppForStatements}
        onClose={() => setSelectedAppForStatements(null)}
      />

      {/* Application Details Dialog */}
      <Dialog open={!!selectedAppDetails} onOpenChange={(open) => { if (!open) { setSelectedAppDetails(null); setIsEditMode(false); setEditFormData({}); } }}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-3 flex-wrap">
              {isEditMode ? "Edit Application" : "Application Details"}
              {selectedAppDetails?.isFullApplicationCompleted ? (
                <Badge variant="default" className="bg-green-600">
                  <CheckCircle2 className="w-3 h-3 mr-1" />
                  Full App
                </Badge>
              ) : selectedAppDetails?.isCompleted ? (
                <Badge variant="secondary">
                  <Clock className="w-3 h-3 mr-1" />
                  Intake Only
                </Badge>
              ) : (
                <Badge variant="outline">Incomplete</Badge>
              )}
            </DialogTitle>
          </DialogHeader>

          {selectedAppDetails && !isEditMode && (
            <div className="space-y-6">
              {/* Contact Information */}
              <div>
                <h4 className="font-semibold text-sm text-muted-foreground mb-3 uppercase tracking-wide">Contact Information</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                  <div><span className="font-medium">Full Name:</span> {selectedAppDetails.fullName || "N/A"}</div>
                  <div><span className="font-medium">Email:</span> {selectedAppDetails.email || "N/A"}</div>
                  <div><span className="font-medium">Phone:</span> {selectedAppDetails.phone || "N/A"}</div>
                  {selectedAppDetails.dateOfBirth && (
                    <div><span className="font-medium">DOB:</span> {selectedAppDetails.dateOfBirth}</div>
                  )}
                </div>
              </div>

              {/* Business Information */}
              <div>
                <h4 className="font-semibold text-sm text-muted-foreground mb-3 uppercase tracking-wide">Business Information</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                  <div><span className="font-medium">Legal Name:</span> {selectedAppDetails.legalBusinessName || selectedAppDetails.businessName || "N/A"}</div>
                  <div><span className="font-medium">DBA:</span> {selectedAppDetails.doingBusinessAs || "N/A"}</div>
                  <div><span className="font-medium">Industry:</span> {selectedAppDetails.industry || "N/A"}</div>
                  <div><span className="font-medium">EIN:</span> {selectedAppDetails.ein || "N/A"}</div>
                  <div><span className="font-medium">Start Date:</span> {selectedAppDetails.businessStartDate || "N/A"}</div>
                  <div><span className="font-medium">State of Inc:</span> {selectedAppDetails.stateOfIncorporation || "N/A"}</div>
                  <div><span className="font-medium">Company Email:</span> {selectedAppDetails.companyEmail || "N/A"}</div>
                  <div><span className="font-medium">Website:</span> {selectedAppDetails.companyWebsite || "N/A"}</div>
                </div>
              </div>

              {/* Business Address */}
              {(selectedAppDetails.businessStreetAddress || selectedAppDetails.businessAddress || selectedAppDetails.city) && (
                <div>
                  <h4 className="font-semibold text-sm text-muted-foreground mb-3 uppercase tracking-wide">Business Address</h4>
                  <div className="text-sm">
                    <p>{selectedAppDetails.businessStreetAddress || selectedAppDetails.businessAddress || "N/A"}</p>
                    <p>{selectedAppDetails.businessCsz || `${selectedAppDetails.city || ""} ${selectedAppDetails.state || ""} ${selectedAppDetails.zipCode || ""}`.trim() || "N/A"}</p>
                  </div>
                </div>
              )}

              {/* Owner Address (for full applications) */}
              {selectedAppDetails.ownerAddress1 && (
                <div>
                  <h4 className="font-semibold text-sm text-muted-foreground mb-3 uppercase tracking-wide">Owner Address</h4>
                  <div className="text-sm">
                    <p>{selectedAppDetails.ownerAddress1} {selectedAppDetails.ownerAddress2 || ""}</p>
                    <p>{selectedAppDetails.ownerCsz || `${selectedAppDetails.ownerCity || ""} ${selectedAppDetails.ownerState || ""} ${selectedAppDetails.ownerZip || ""}`.trim() || "N/A"}</p>
                  </div>
                </div>
              )}

              {/* Financial Information */}
              <div>
                <h4 className="font-semibold text-sm text-muted-foreground mb-3 uppercase tracking-wide">Financial Information</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                  <div><span className="font-medium">Requested Amount:</span> {selectedAppDetails.requestedAmount ? `$${Number(selectedAppDetails.requestedAmount).toLocaleString()}` : "N/A"}</div>
                  <div><span className="font-medium">Monthly Revenue:</span> {selectedAppDetails.monthlyRevenue || selectedAppDetails.averageMonthlyRevenue ? `$${Number(selectedAppDetails.monthlyRevenue || selectedAppDetails.averageMonthlyRevenue).toLocaleString()}` : "N/A"}</div>
                  <div><span className="font-medium">Credit Cards:</span> {selectedAppDetails.doYouProcessCreditCards || "N/A"}</div>
                  {(selectedAppDetails.personalCreditScoreRange || selectedAppDetails.ficoScoreExact) && (
                    <div><span className="font-medium">Credit Score:</span> {selectedAppDetails.ficoScoreExact || selectedAppDetails.personalCreditScoreRange}</div>
                  )}
                  {selectedAppDetails.ownership && (
                    <div><span className="font-medium">Ownership %:</span> {selectedAppDetails.ownership}%</div>
                  )}
                  {selectedAppDetails.mcaBalanceAmount && (
                    <div><span className="font-medium">MCA Balance:</span> ${Number(selectedAppDetails.mcaBalanceAmount).toLocaleString()}</div>
                  )}
                  {selectedAppDetails.mcaBalanceBankName && (
                    <div><span className="font-medium">MCA Bank:</span> {selectedAppDetails.mcaBalanceBankName}</div>
                  )}
                </div>
              </div>

              {/* Agent Information */}
              {(selectedAppDetails.agentName || (selectedAppDetails as any).referralPartnerName) && (
                <div>
                  <h4 className="font-semibold text-sm text-muted-foreground mb-3 uppercase tracking-wide">Agent Information</h4>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                    {selectedAppDetails.agentName && (
                      <>
                        <div><span className="font-medium">Agent:</span> {selectedAppDetails.agentName}</div>
                        <div><span className="font-medium">Agent Email:</span> {selectedAppDetails.agentEmail || "N/A"}</div>
                      </>
                    )}
                    {(selectedAppDetails as any).referralPartnerName && (
                      <div><span className="font-medium">Referring Partner:</span> {(selectedAppDetails as any).referralPartnerName}</div>
                    )}
                  </div>
                </div>
              )}

              {/* Progress Information for Partial Applications */}
              {!selectedAppDetails.isCompleted && !selectedAppDetails.isFullApplicationCompleted && (
                <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg p-4">
                  <h4 className="font-semibold text-sm text-amber-800 dark:text-amber-200 mb-2">Application Progress</h4>
                  <p className="text-sm text-amber-700 dark:text-amber-300">
                    This application is incomplete. The user stopped at step {selectedAppDetails.currentStep || 1} of the intake process.
                    Consider following up with the applicant to help them complete their application.
                  </p>
                </div>
              )}

              {/* Metadata */}
              <div className="pt-4 border-t">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs text-muted-foreground">
                  <div>Created: {selectedAppDetails.createdAt ? format(new Date(selectedAppDetails.createdAt), "MMM d, yyyy h:mm a") : "N/A"}</div>
                  <div>Updated: {selectedAppDetails.updatedAt ? format(new Date(selectedAppDetails.updatedAt), "MMM d, yyyy h:mm a") : "N/A"}</div>
                  <div>ID: {selectedAppDetails.id}</div>
                  {selectedAppDetails.ghlContactId && <div>GHL ID: {selectedAppDetails.ghlContactId}</div>}
                </div>
              </div>

              {/* Action Buttons - View Application available for all apps */}
              <div className="flex gap-3 pt-4 border-t flex-wrap">
                <Button
                  variant="outline"
                  onClick={handleEditClick}
                  data-testid="button-edit-application"
                >
                  <Pencil className="w-4 h-4 mr-2" />
                  Edit Application
                </Button>
                <Button
                  onClick={() => window.open(`/agent/application/${selectedAppDetails.id}`, "_blank")}
                  data-testid="button-view-application"
                >
                  <ExternalLink className="w-4 h-4 mr-2" />
                  View Application
                </Button>
              </div>
            </div>
          )}

          {/* Edit Mode Form */}
          {selectedAppDetails && isEditMode && (
            <div className="space-y-6">
              {/* Error Display */}
              {saveApplicationMutation.isError && (
                <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-md">
                  <p className="text-sm text-destructive">{(saveApplicationMutation.error as Error).message}</p>
                </div>
              )}

              {/* Contact Information */}
              <div>
                <h4 className="font-semibold text-sm text-muted-foreground mb-3 uppercase tracking-wide">Contact Information</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="edit-fullName">Full Name</Label>
                    <Input
                      id="edit-fullName"
                      value={editFormData.fullName || ""}
                      onChange={(e) => handleEditFieldChange("fullName", e.target.value)}
                      placeholder="Full Name"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="edit-email">Email</Label>
                    <Input
                      id="edit-email"
                      type="email"
                      value={editFormData.email || ""}
                      onChange={(e) => handleEditFieldChange("email", e.target.value)}
                      placeholder="Email"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="edit-phone">Phone</Label>
                    <Input
                      id="edit-phone"
                      value={editFormData.phone || ""}
                      onChange={(e) => handleEditFieldChange("phone", e.target.value)}
                      placeholder="Phone"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="edit-dateOfBirth">Date of Birth</Label>
                    <Input
                      id="edit-dateOfBirth"
                      type="date"
                      value={editFormData.dateOfBirth || ""}
                      onChange={(e) => handleEditFieldChange("dateOfBirth", e.target.value)}
                    />
                  </div>
                </div>
              </div>

              {/* Business Information */}
              <div>
                <h4 className="font-semibold text-sm text-muted-foreground mb-3 uppercase tracking-wide">Business Information</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="edit-businessName">Company Name</Label>
                    <Input
                      id="edit-businessName"
                      value={editFormData.businessName || ""}
                      onChange={(e) => handleEditFieldChange("businessName", e.target.value)}
                      placeholder="Company Name"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="edit-legalBusinessName">Legal Business Name</Label>
                    <Input
                      id="edit-legalBusinessName"
                      value={editFormData.legalBusinessName || ""}
                      onChange={(e) => handleEditFieldChange("legalBusinessName", e.target.value)}
                      placeholder="Legal Business Name"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="edit-doingBusinessAs">DBA</Label>
                    <Input
                      id="edit-doingBusinessAs"
                      value={editFormData.doingBusinessAs || ""}
                      onChange={(e) => handleEditFieldChange("doingBusinessAs", e.target.value)}
                      placeholder="Doing Business As"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="edit-industry">Industry</Label>
                    <Select
                      value={editFormData.industry || ""}
                      onValueChange={(value) => handleEditFieldChange("industry", value)}
                    >
                      <SelectTrigger id="edit-industry">
                        <SelectValue placeholder="Select Industry" />
                      </SelectTrigger>
                      <SelectContent>
                        {INDUSTRIES.map((ind) => (
                          <SelectItem key={ind} value={ind}>{ind}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="edit-ein">EIN</Label>
                    <Input
                      id="edit-ein"
                      value={editFormData.ein || ""}
                      onChange={(e) => handleEditFieldChange("ein", e.target.value)}
                      placeholder="XX-XXXXXXX"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="edit-businessStartDate">Business Start Date</Label>
                    <Input
                      id="edit-businessStartDate"
                      type="date"
                      value={editFormData.businessStartDate || ""}
                      onChange={(e) => handleEditFieldChange("businessStartDate", e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="edit-stateOfIncorporation">State of Incorporation</Label>
                    <Select
                      value={editFormData.stateOfIncorporation || ""}
                      onValueChange={(value) => handleEditFieldChange("stateOfIncorporation", value)}
                    >
                      <SelectTrigger id="edit-stateOfIncorporation">
                        <SelectValue placeholder="Select State" />
                      </SelectTrigger>
                      <SelectContent>
                        {US_STATES.map((state) => (
                          <SelectItem key={state} value={state}>{state}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="edit-companyEmail">Company Email</Label>
                    <Input
                      id="edit-companyEmail"
                      type="email"
                      value={editFormData.companyEmail || ""}
                      onChange={(e) => handleEditFieldChange("companyEmail", e.target.value)}
                      placeholder="Company Email"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="edit-companyWebsite">Website</Label>
                    <Input
                      id="edit-companyWebsite"
                      value={editFormData.companyWebsite || ""}
                      onChange={(e) => handleEditFieldChange("companyWebsite", e.target.value)}
                      placeholder="www.example.com"
                    />
                  </div>
                </div>
              </div>

              {/* Business Address */}
              <div>
                <h4 className="font-semibold text-sm text-muted-foreground mb-3 uppercase tracking-wide">Business Address</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2 md:col-span-2">
                    <Label htmlFor="edit-businessAddress">Street Address</Label>
                    <Input
                      id="edit-businessAddress"
                      value={editFormData.businessAddress || ""}
                      onChange={(e) => handleEditFieldChange("businessAddress", e.target.value)}
                      placeholder="Street Address"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="edit-city">City</Label>
                    <Input
                      id="edit-city"
                      value={editFormData.city || ""}
                      onChange={(e) => handleEditFieldChange("city", e.target.value)}
                      placeholder="City"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="edit-state">State</Label>
                      <Select
                        value={editFormData.state || ""}
                        onValueChange={(value) => handleEditFieldChange("state", value)}
                      >
                        <SelectTrigger id="edit-state">
                          <SelectValue placeholder="State" />
                        </SelectTrigger>
                        <SelectContent>
                          {US_STATES.map((state) => (
                            <SelectItem key={state} value={state}>{state}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="edit-zipCode">ZIP Code</Label>
                      <Input
                        id="edit-zipCode"
                        value={editFormData.zipCode || ""}
                        onChange={(e) => handleEditFieldChange("zipCode", e.target.value)}
                        placeholder="ZIP"
                        maxLength={5}
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* Owner Address */}
              <div>
                <h4 className="font-semibold text-sm text-muted-foreground mb-3 uppercase tracking-wide">Owner Address</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="edit-ownerAddress1">Address Line 1</Label>
                    <Input
                      id="edit-ownerAddress1"
                      value={editFormData.ownerAddress1 || ""}
                      onChange={(e) => handleEditFieldChange("ownerAddress1", e.target.value)}
                      placeholder="Street Address"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="edit-ownerAddress2">Address Line 2</Label>
                    <Input
                      id="edit-ownerAddress2"
                      value={editFormData.ownerAddress2 || ""}
                      onChange={(e) => handleEditFieldChange("ownerAddress2", e.target.value)}
                      placeholder="Apt, Suite, etc."
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="edit-ownerCity">City</Label>
                    <Input
                      id="edit-ownerCity"
                      value={editFormData.ownerCity || ""}
                      onChange={(e) => handleEditFieldChange("ownerCity", e.target.value)}
                      placeholder="City"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="edit-ownerState">State</Label>
                      <Select
                        value={editFormData.ownerState || ""}
                        onValueChange={(value) => handleEditFieldChange("ownerState", value)}
                      >
                        <SelectTrigger id="edit-ownerState">
                          <SelectValue placeholder="State" />
                        </SelectTrigger>
                        <SelectContent>
                          {US_STATES.map((state) => (
                            <SelectItem key={state} value={state}>{state}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="edit-ownerZip">ZIP Code</Label>
                      <Input
                        id="edit-ownerZip"
                        value={editFormData.ownerZip || ""}
                        onChange={(e) => handleEditFieldChange("ownerZip", e.target.value)}
                        placeholder="ZIP"
                        maxLength={5}
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* Financial Information */}
              <div>
                <h4 className="font-semibold text-sm text-muted-foreground mb-3 uppercase tracking-wide">Financial Information</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="edit-requestedAmount">Requested Amount</Label>
                    <Input
                      id="edit-requestedAmount"
                      value={editFormData.requestedAmount || ""}
                      onChange={(e) => handleEditFieldChange("requestedAmount", e.target.value)}
                      placeholder="$0"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="edit-doYouProcessCreditCards">Process Credit Cards?</Label>
                    <Select
                      value={editFormData.doYouProcessCreditCards || ""}
                      onValueChange={(value) => handleEditFieldChange("doYouProcessCreditCards", value)}
                    >
                      <SelectTrigger id="edit-doYouProcessCreditCards">
                        <SelectValue placeholder="Select" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="Yes">Yes</SelectItem>
                        <SelectItem value="No">No</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="edit-ficoScoreExact">FICO Score</Label>
                    <Input
                      id="edit-ficoScoreExact"
                      value={editFormData.ficoScoreExact || ""}
                      onChange={(e) => handleEditFieldChange("ficoScoreExact", e.target.value)}
                      placeholder="e.g. 720"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="edit-ownership">Ownership %</Label>
                    <Input
                      id="edit-ownership"
                      value={editFormData.ownership || ""}
                      onChange={(e) => handleEditFieldChange("ownership", e.target.value)}
                      placeholder="100"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="edit-mcaBalanceAmount">MCA Balance</Label>
                    <Input
                      id="edit-mcaBalanceAmount"
                      value={editFormData.mcaBalanceAmount || ""}
                      onChange={(e) => handleEditFieldChange("mcaBalanceAmount", e.target.value)}
                      placeholder="$0"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="edit-mcaBalanceBankName">MCA Bank Name</Label>
                    <Input
                      id="edit-mcaBalanceBankName"
                      value={editFormData.mcaBalanceBankName || ""}
                      onChange={(e) => handleEditFieldChange("mcaBalanceBankName", e.target.value)}
                      placeholder="Bank Name"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="edit-socialSecurityNumber">SSN</Label>
                    <Input
                      id="edit-socialSecurityNumber"
                      value={editFormData.socialSecurityNumber || ""}
                      onChange={(e) => handleEditFieldChange("socialSecurityNumber", e.target.value)}
                      placeholder="XXX-XX-XXXX"
                    />
                  </div>
                </div>
              </div>

              {/* Re-sign Application */}
              <div className="pt-4 border-t">
                <div className="flex items-start gap-3 p-3 rounded-md bg-muted/50">
                  <Checkbox
                    id="resign-application"
                    checked={resignApplication}
                    onCheckedChange={(checked) => setResignApplication(checked === true)}
                    data-testid="checkbox-resign-application"
                  />
                  <div className="space-y-1">
                    <Label htmlFor="resign-application" className="cursor-pointer font-medium">
                      Re-sign Application
                    </Label>
                    <p className="text-sm text-muted-foreground">
                      Check this box to update the e-signature date to the current date, overriding the original submission date.
                      {resignApplication && (
                        <span className="block mt-1 font-medium text-foreground">
                          New signature date will be set to: {new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
                        </span>
                      )}
                    </p>
                  </div>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex gap-3 pt-4 border-t">
                <Button
                  onClick={handleSaveEdit}
                  disabled={saveApplicationMutation.isPending}
                  data-testid="button-save-application"
                >
                  {saveApplicationMutation.isPending ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Saving...
                    </>
                  ) : (
                    <>
                      <Save className="w-4 h-4 mr-2" />
                      Save Changes
                    </>
                  )}
                </Button>
                <Button
                  variant="outline"
                  onClick={handleCancelEdit}
                  disabled={saveApplicationMutation.isPending}
                  data-testid="button-cancel-edit"
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

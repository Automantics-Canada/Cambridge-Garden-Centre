import React, { useState, useEffect, useCallback } from 'react';
import { useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import api from '../../api/axios';
import { ChevronRight, Users, Inbox } from 'lucide-react';
import { Skeleton } from '../../components/Skeleton';
import { formatDate } from '../../lib/date';
import {
  PageHeader,
  StatTile,
  Card,
  CardHeader,
  CardBody,
  CardDivider,
  StatusBadge,
  Button,
  EmptyState,
} from '../../components/ui';

export default function Dashboard() {
  const user = useSelector((state) => state.auth.user);
  const navigate = useNavigate();
  const [stats, setStats] = useState({
    totalMonthly: 0,
    pendingCount: 0,
    disputedCount: 0,
    savingsDetected: 0,
  });
  const [recentInvoices, setRecentInvoices] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchDashboardData = useCallback(async () => {
    setLoading(true);
    try {
      // Use the same Railway API as the authenticated write flows. The Edge
      // function adds a multi-second floor to every dashboard visit and has a
      // separate deployment lifecycle that already drifted from the frontend.
      const response = await api.get('/api/invoices');
      const invoices = Array.isArray(response.data) ? response.data : [];
      const now = new Date();

      setRecentInvoices(invoices.slice(0, 5));
      setStats(current => ({
        ...current,
        totalMonthly: invoices.filter(invoice => {
          const receivedAt = new Date(invoice.receivedAt);
          return receivedAt.getMonth() === now.getMonth()
            && receivedAt.getFullYear() === now.getFullYear();
        }).length,
        pendingCount: invoices.filter(invoice => invoice.status === 'PENDING_REVIEW').length,
        disputedCount: invoices.filter(invoice => invoice.status === 'DISPUTED').length,
      }));

    } catch (err) {
      console.error('Error fetching dashboard data:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDashboardData();
  }, [fetchDashboardData]);

  const firstName = (user?.name || 'there').split(' ')[0];

  if (loading) return <DashboardSkeleton firstName={firstName} />;

  return (
    <div className="max-w-6xl mx-auto space-y-8">
      <PageHeader
        title={`Good to see you, ${firstName}`}
        subtitle="Everything waiting on you today, in one place."
      />

      {/* The numbers that matter. Big, quiet, scannable. */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
        <StatTile
          label="Waiting for review"
          value={stats.pendingCount}
          tone={stats.pendingCount > 0 ? 'warn' : 'default'}
          hint="Invoices nobody has checked yet"
          onClick={() => navigate('/dashboard/invoices')}
        />
        <StatTile
          label="Disputed"
          value={stats.disputedCount}
          tone={stats.disputedCount > 0 ? 'bad' : 'default'}
          hint="Charges that don't match the agreed rate"
          onClick={() => navigate('/dashboard/invoices')}
        />
        <StatTile
          label="Processed this month"
          value={stats.totalMonthly}
          hint="Invoices received since the 1st"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        {/* Recent activity */}
        <Card className="lg:col-span-2 overflow-hidden">
          <CardHeader
            title="Recent activity"
            subtitle="The last five invoices to arrive"
            action={
              <Button
                variant="ghost"
                size="sm"
                onClick={() => navigate('/dashboard/invoices')}
              >
                View all
                <ChevronRight size={15} />
              </Button>
            }
          />

          {recentInvoices.length === 0 ? (
            <>
              <CardDivider />
              <EmptyState
                icon={Inbox}
                title="Nothing has come in yet"
                message="Invoices appear here as soon as they are received and read."
              />
            </>
          ) : (
            <div>
              {recentInvoices.map((inv) => (
                <button
                  key={inv.id}
                  onClick={() => navigate(`/dashboard/invoices/${inv.id}`)}
                  className="w-full flex items-center gap-4 px-6 py-4 border-t border-line text-left hover:bg-brand/[0.04] transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-[14.5px] font-semibold text-ink truncate">
                      {inv.invoiceNumber || 'Untitled invoice'}
                    </p>
                    <p className="text-[13px] text-muted truncate">
                      {inv.supplier?.name || 'Unknown supplier'}
                      {inv.receivedAt &&
                        ` · ${formatDate(inv.receivedAt, 'en-CA')}`}
                    </p>
                  </div>
                  <p className="tabular text-[15px] font-semibold text-ink text-right min-w-[92px]">
                    ${Number(inv.totalAmount || 0).toFixed(2)}
                  </p>
                  <StatusBadge status={inv.status} />
                </button>
              ))}
            </div>
          )}
        </Card>

        {/* Side column */}
        <div className="space-y-6">
          <Card>
            <CardHeader title="Shortcuts" />
            <CardBody className="space-y-2">
              <button
                onClick={() => navigate('/dashboard/supplier')}
                className="w-full flex items-center gap-3 p-3.5 rounded-control border border-line hover:border-brand/40 hover:bg-brand/[0.04] transition-colors text-left"
              >
                <div className="w-9 h-9 rounded-control bg-brand/10 flex items-center justify-center flex-none">
                  <Users size={17} className="text-brand" strokeWidth={1.75} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] font-semibold text-ink">
                    Manage suppliers
                  </p>
                  <p className="text-[12.5px] text-muted">
                    Names, codes and contacts
                  </p>
                </div>
                <ChevronRight size={16} className="text-muted flex-none" />
              </button>
            </CardBody>
          </Card>

          <Card className="bg-brand/[0.06] border-brand/20">
            <CardBody className="pt-5">
              <p className="text-[13.5px] font-semibold text-ink">
                Import orders first
              </p>
              <p className="text-[13px] text-muted mt-1.5 leading-relaxed">
                Bring in Spruce orders before you verify invoices. The system can
                only match a charge against an order it already has.
              </p>
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}

function DashboardSkeleton({ firstName }) {
  return (
    <div className="max-w-6xl mx-auto space-y-8">
      <PageHeader
        title={`Good to see you, ${firstName}`}
        subtitle="Everything waiting on you today, in one place."
      />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
        {[...Array(3)].map((_, i) => (
          <Card key={i} className="px-6 py-6 space-y-3">
            <Skeleton variant="text" width="110px" height="14px" />
            <Skeleton variant="text" width="80px" height="42px" />
            <Skeleton variant="text" width="140px" height="13px" />
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        <Card className="lg:col-span-2 overflow-hidden">
          <div className="px-6 pt-5 pb-4 space-y-2">
            <Skeleton variant="text" width="160px" height="20px" />
            <Skeleton variant="text" width="220px" height="14px" />
          </div>
          {[...Array(5)].map((_, i) => (
            <div
              key={i}
              className="flex items-center gap-4 px-6 py-4 border-t border-line"
            >
              <div className="flex-1 space-y-2">
                <Skeleton variant="text" width="140px" height="15px" />
                <Skeleton variant="text" width="180px" height="13px" />
              </div>
              <Skeleton variant="text" width="80px" height="15px" />
              <Skeleton variant="rectangle" width="86px" height="24px" className="rounded-full" />
            </div>
          ))}
        </Card>

        <div className="space-y-6">
          <Card className="px-6 py-5 space-y-4">
            <Skeleton variant="text" width="110px" height="20px" />
            <Skeleton variant="rectangle" height="64px" className="rounded-control" />
          </Card>
          <Card className="px-6 py-5 space-y-2">
            <Skeleton variant="text" width="150px" height="16px" />
            <Skeleton variant="rectangle" height="52px" className="rounded-control" />
          </Card>
        </div>
      </div>
    </div>
  );
}

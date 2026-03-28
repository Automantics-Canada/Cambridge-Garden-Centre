import React from 'react';
import { Truck, Clock, DollarSign, CheckCircle } from 'lucide-react';
import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend
} from 'recharts';

// Mock Data
const barData = [
  { name: 'Mon', main: 8, contract: 2 },
  { name: 'Tue', main: 11, contract: 0 },
  { name: 'Wed', main: 9, contract: 3 },
  { name: 'Thu', main: 12, contract: 4 },
  { name: 'Fri', main: 10, contract: 2 },
  { name: 'Sat', main: 7, contract: 1 },
];

const pieData = [
  { name: 'Regular Customers', value: 75 },
  { name: 'Contractors', value: 25 },
];
const COLORS = ['#2D6A4F', '#D4A35B']; // Dark green and gold-brown matching image

export default function Dashboard() {
  const currentDate = new Date('2026-03-08T00:00:00'); // Force date for consistency with image design
  const dateOptions = { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' };

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold text-gray-900 tracking-tight flex items-center gap-2">
          Good morning, Sarah <span className="text-2xl">👋</span>
        </h1>
        <p className="text-gray-500 text-sm mt-1">{currentDate.toLocaleDateString('en-US', dateOptions)}</p>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard 
          title="Deliveries Today" 
          value="14" 
          trend="↑ 3 from yesterday" 
          trendColor="text-green-500" 
          icon={<Truck size={20} />} 
          borderColor="border-green-600"
        />
        <KpiCard 
          title="Pending Dispatch" 
          value="6" 
          trend="" 
          icon={<Clock size={20} />} 
          borderColor="border-orange-400"
        />
        <KpiCard 
          title="Outstanding (Contractors)" 
          value="$12,840" 
          trend="" 
          icon={<DollarSign size={20} />} 
          borderColor="border-yellow-500"
        />
        <KpiCard 
          title="Completed This Week" 
          value="47" 
          trend="↑ 12%" 
          trendColor="text-green-500" 
          icon={<CheckCircle size={20} />} 
          borderColor="border-green-500"
        />
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm lg:col-span-2">
          <h2 className="text-lg font-bold text-gray-800 mb-6">Deliveries This Week</h2>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={barData} margin={{ top: 5, right: 30, left: -20, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E5E7EB" />
                <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{fill: '#6B7280'}} />
                <YAxis axisLine={false} tickLine={false} tick={{fill: '#6B7280'}} ticks={[0,3,6,9,12]} />
                <Tooltip cursor={{fill: '#f3f4f6'}} />
                <Bar dataKey="main" stackId="a" fill="#2D6A4F" radius={[0, 0, 0, 0]} />
                <Bar dataKey="contract" stackId="a" fill="#D4A35B" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm">
          <h2 className="text-lg font-bold text-gray-800 mb-2">Customer Split</h2>
          <div className="h-64 w-full flex items-center justify-center relative">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={pieData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={90}
                  paddingAngle={5}
                  dataKey="value"
                  stroke="none"
                >
                  {pieData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Legend 
                  verticalAlign="bottom" 
                  height={36} 
                  iconType="square" 
                  formatter={(value) => <span className="text-gray-600 font-medium pl-1">{value}</span>}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Bottom Table Placeholder */}
      <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm min-h-[300px]">
         <h2 className="text-lg font-bold text-gray-800 mb-4 border-b pb-4">Today's Deliveries — Live Status</h2>
         <div className="text-gray-500 text-center py-12">
            Static Data Placeholder for Deliveries Table
         </div>
      </div>
    </div>
  );
}

function KpiCard({ title, value, trend, trendColor, icon, borderColor }) {
  return (
    <div className={`bg-white rounded-xl p-5 border-l-4 border-y border-r border-gray-200 shadow-sm flex flex-col justify-between ${borderColor}`}>
      <div className="flex justify-between items-start mb-2">
        <h3 className="text-gray-500 text-sm font-medium">{title}</h3>
        <div className="text-gray-400 bg-gray-50 p-1.5 rounded-md border border-gray-100">{icon}</div>
      </div>
      <div>
        <div className="text-3xl font-bold text-gray-900 tracking-tight">{value}</div>
        <div className={`text-xs mt-1 ${trendColor || 'text-gray-400'} h-4`}>{trend}</div>
      </div>
    </div>
  );
}

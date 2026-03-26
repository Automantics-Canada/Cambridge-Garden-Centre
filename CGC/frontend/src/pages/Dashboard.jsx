import React from 'react';
import { Users, FileText, TrendingUp, DollarSign } from 'lucide-react';

export default function Dashboard() {
  const stats = [
    { name: 'Total Suppliers', value: '142', icon: Users, change: '+12%', changeType: 'positive' },
    { name: 'Active Rates', value: '854', icon: FileText, change: '+5%', changeType: 'positive' },
    { name: 'Average Savings', value: '$12,450', icon: DollarSign, change: '+18%', changeType: 'positive' },
    { name: 'Performance Metric', value: '94%', icon: TrendingUp, change: '-1%', changeType: 'negative' },
  ];

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Dashboard Overview</h1>
          <p className="text-gray-500 mt-1">Welcome back. Here's what's happening today.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {stats.map((stat) => (
          <div key={stat.name} className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 hover:shadow-md transition-shadow">
            <div className="flex items-center justify-between">
              <div className="bg-primary-50 p-3 rounded-xl">
                <stat.icon className="w-6 h-6 text-primary-600" />
              </div>
              <div className={`px-2.5 py-1 rounded-full text-xs font-medium ${
                stat.changeType === 'positive' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
              }`}>
                {stat.change}
              </div>
            </div>
            <div className="mt-6">
              <div className="text-3xl font-bold text-gray-900">{stat.value}</div>
              <div className="text-sm text-gray-500 mt-1">{stat.name}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 min-h-[400px] flex items-center justify-center">
        <div className="text-center text-gray-400">
          <TrendingUp className="w-16 h-16 mx-auto mb-4 opacity-20" />
          <p>Analytics charts will be rendered here</p>
        </div>
      </div>
    </div>
  );
}

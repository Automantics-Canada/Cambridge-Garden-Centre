import React from 'react';
import { Link } from 'react-router-dom';
import { Truck, FileText, ClipboardList, ShieldCheck } from 'lucide-react';

export default function LandingPage() {
  return (
    <div className="min-h-screen flex flex-col font-sans bg-white">
      {/* Navigation */}
      <nav className="flex justify-between items-center p-6 lg:px-12 border-b bg-white sticky top-0 z-50">
        <div className="text-2xl font-bold text-[#1B4332] tracking-tight">CGC <span className="text-[#1D5333] font-light">| Operations</span></div>
        <div className="space-x-8 hidden md:block">
          <a href="#features" className="text-gray-600 hover:text-[#1D5333] font-medium transition-colors">Features</a>
          <a href="#how-it-works" className="text-gray-600 hover:text-[#1D5333] font-medium transition-colors">How it Works</a>
        </div>
        <Link to="/login" className="bg-[#1D5333] hover:bg-[#153e26] text-white px-6 py-2 rounded-md font-medium transition-colors shadow-sm">
          Sign In
        </Link>
      </nav>

      {/* Hero Section */}
      <section className="flex-1 flex flex-col items-center justify-center text-center px-4 py-24 lg:py-32 bg-gradient-to-br from-[#f8fdf9] to-[#e6f4ea]">
        <h1 className="text-5xl lg:text-7xl font-extrabold text-[#1B4332] mb-6 tracking-tight max-w-4xl leading-tight">
          Streamline Your Logistics & <span className="text-[#1D5333]">Ticket Management</span>
        </h1>
        <p className="text-xl text-gray-600 mb-10 max-w-2xl leading-relaxed">
          The ultimate platform for complete visibility over your deliveries, driver activity, and invoicing. Automate your back-office today.
        </p>
        <div className="flex gap-4">
          <Link to="/login" className="bg-[#1B4332] hover:bg-[#153e26] text-white px-8 py-3 rounded-md text-lg font-medium transition-all shadow-lg hover:shadow-xl">
            Go to Dashboard
          </Link>
          <a href="#features" className="bg-white border-2 border-[#1B4332] text-[#1B4332] hover:bg-gray-50 px-8 py-3 rounded-md text-lg font-medium transition-all">
            See Features
          </a>
        </div>
      </section>

      {/* Features Section 1 */}
      <section id="features" className="py-24 px-6 lg:px-24 bg-white">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl font-bold text-[#1B4332]">Everything you need to run operations</h2>
            <p className="text-gray-500 mt-4 text-lg">Centralize your entire workflow in one green-themed portal.</p>
          </div>
          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-12">
            {[
              { title: "Real-time Dispatch", desc: "Monitor live deliveries and driver statuses instantly.", icon: <Truck size={32} /> },
              { title: "Smart Invoicing", desc: "Automate reconciliation between tickets and invoices.", icon: <FileText size={32} /> },
              { title: "Order Management", desc: "Seamlessly handle incoming customer and contractor orders.", icon: <ClipboardList size={32} /> },
              { title: "Secure & Reliable", desc: "Enterprise-grade security for your operational data.", icon: <ShieldCheck size={32} /> }
            ].map((feature, idx) => (
              <div key={idx} className="bg-[#f8fdf9] p-8 rounded-xl border border-green-100 hover:shadow-lg transition-shadow">
                <div className="text-[#1D5333] mb-4 bg-white w-16 h-16 flex items-center justify-center rounded-full shadow-sm">
                  {feature.icon}
                </div>
                <h3 className="text-xl font-bold text-[#1B4332] mb-3">{feature.title}</h3>
                <p className="text-gray-600">{feature.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Section 2: Info/Banner */}
      <section id="how-it-works" className="py-24 px-6 lg:px-24 bg-[#1B4332] text-white">
        <div className="max-w-5xl mx-auto text-center">
          <h2 className="text-4xl font-bold mb-8">Ready to cut manual data entry by 80%?</h2>
          <p className="text-xl text-green-100 mb-10 max-w-2xl mx-auto">
            Our intelligent OCR engine captures ticket data instantly. 
            Connect your dispatch team, drivers, and accounting staff in a single unified platform.
          </p>
          <Link to="/login" className="bg-white text-[#1B4332] hover:bg-gray-100 px-10 py-4 rounded-md text-xl font-bold transition-colors inline-block shadow-lg">
            Access Portal
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-gray-50 border-t py-12 px-6 lg:px-24 text-center">
        <div className="max-w-7xl mx-auto flex flex-col items-center">
          <div className="text-2xl font-bold text-[#1B4332] mb-6">CGC<span className="font-light">Operations</span></div>
          <div className="flex gap-6 mb-8 text-gray-500">
            <a href="#privacy" className="hover:text-[#1D5333]">Privacy Policy</a>
            <a href="#terms" className="hover:text-[#1D5333]">Terms of Service</a>
            <a href="#support" className="hover:text-[#1D5333]">Support</a>
          </div>
          <p className="text-gray-400">© 2026 Cambridge Garden Centre. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
}

import React from 'react';
import { Link } from 'react-router-dom';
import Navbar from '../components/Navbar';
import { Leaf, Truck, Sprout, ArrowRight } from 'lucide-react';

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-green-50">
      <Navbar />
      
      {/* Hero Section */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-20">
        <div className="text-center">
          <h1 className="text-4xl tracking-tight font-extrabold text-green-900 sm:text-5xl md:text-6xl">
            <span className="block">Premium Plants & Supplies</span>
            <span className="block text-green-600">for Exceptional Gardens</span>
          </h1>
          <p className="mt-3 max-w-md mx-auto text-base text-green-700 sm:text-lg md:mt-5 md:text-xl md:max-w-3xl">
            Cambridge Garden Centre provides high-quality plants, soil, mulches, and professional gardening supplies to contractors and retail customers alike. Your green oasis starts here.
          </p>
          <div className="mt-5 max-w-md mx-auto sm:flex sm:justify-center md:mt-8">
            <div className="rounded-md shadow">
              <Link
                to="/dashboard/orders"
                className="w-full flex items-center justify-center px-8 py-3 border border-transparent text-base font-medium rounded-md text-white bg-green-600 hover:bg-green-700 md:py-4 md:text-lg md:px-10 transition-colors"
                id="hero-dashboard-btn"
              >
                Go to Dashboard
                <ArrowRight className="ml-2 w-5 h-5" />
              </Link>
            </div>
            <div className="mt-3 rounded-md shadow sm:mt-0 sm:ml-3">
              <a
                href="#features"
                className="w-full flex items-center justify-center px-8 py-3 border border-green-200 text-base font-medium rounded-md text-green-700 bg-white hover:bg-green-50 md:py-4 md:text-lg md:px-10 transition-colors"
              >
                Learn More
              </a>
            </div>
          </div>
        </div>
      </div>

      {/* Feature section */}
      <div id="features" className="py-16 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3">
            <div className="pt-6">
              <div className="flow-root bg-green-50 rounded-lg px-6 pb-8">
                <div className="-mt-6">
                  <div>
                    <span className="inline-flex items-center justify-center p-3 bg-green-500 rounded-md shadow-lg">
                      <Sprout className="h-6 w-6 text-white" />
                    </span>
                  </div>
                  <h3 className="mt-8 text-lg font-medium text-green-900 tracking-tight">Premium Quality</h3>
                  <p className="mt-5 text-base text-green-700">
                    Locally sourced and carefully nurtured plants to ensure they thrive in your specific environment.
                  </p>
                </div>
              </div>
            </div>

            <div className="pt-6">
              <div className="flow-root bg-green-50 rounded-lg px-6 pb-8">
                <div className="-mt-6">
                  <div>
                    <span className="inline-flex items-center justify-center p-3 bg-green-500 rounded-md shadow-lg">
                      <Truck className="h-6 w-6 text-white" />
                    </span>
                  </div>
                  <h3 className="mt-8 text-lg font-medium text-green-900 tracking-tight">Fast Delivery</h3>
                  <p className="mt-5 text-base text-green-700">
                    Reliable and quick delivery directly to your home or job site, exactly when you need it.
                  </p>
                </div>
              </div>
            </div>

            <div className="pt-6">
              <div className="flow-root bg-green-50 rounded-lg px-6 pb-8">
                <div className="-mt-6">
                  <div>
                    <span className="inline-flex items-center justify-center p-3 bg-green-500 rounded-md shadow-lg">
                      <Leaf className="h-6 w-6 text-white" />
                    </span>
                  </div>
                  <h3 className="mt-8 text-lg font-medium text-green-900 tracking-tight">Expert Advice</h3>
                  <p className="mt-5 text-base text-green-700">
                    Our team of experienced horticulturists is always ready to help you plan your perfect garden.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

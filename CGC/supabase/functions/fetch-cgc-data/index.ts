import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.0"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Pure Web Crypto HS256 decrypter & verifier
async function verifyHS256(token: string, secret: string): Promise<any | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [headerB64, payloadB64, signatureB64] = parts;
    
    // Decode helpers
    const b64Decode = (str: string) => {
      let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
      while (base64.length % 4) base64 += "=";
      return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    };

    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    
    const key = await crypto.subtle.importKey(
      "raw",
      keyData,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );

    const dataToVerify = encoder.encode(`${headerB64}.${payloadB64}`);
    const rawSig = b64Decode(signatureB64);
    
    const isValid = await crypto.subtle.verify(
      "HMAC",
      key,
      rawSig,
      dataToVerify
    );

    if (!isValid) return null;

    // Parse payload
    const decodedPayload = atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(decodedPayload);
  } catch (e) {
    console.error("JWT verification failed:", e);
    return null;
  }
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
    const jwtSecret = Deno.env.get('JWT_SECRET') || 'super-secret-change-me';

    // Verify user JWT token from authorization header
    const authHeader = req.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response(
        JSON.stringify({ error: 'Missing or invalid Authorization header' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const token = authHeader.split(' ')[1];
    const decodedPayload = await verifyHS256(token, jwtSecret);

    if (!decodedPayload) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized user credentials' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Authenticated successfully! 
    // CRITICAL: We pass a custom fetch handler in options to explicitly bypass and override 
    // the automatic header inheritance/forwarding behavior in Deno edge environments.
    const supabaseClient = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false
      },
      global: {
        fetch: (url, options = {}) => {
          const headers = new Headers(options.headers);
          headers.set('Authorization', `Bearer ${supabaseServiceKey}`);
          headers.set('apikey', supabaseServiceKey);
          return fetch(url, { ...options, headers });
        }
      }
    });

    const url = new URL(req.url);
    const resource = url.searchParams.get('resource'); // 'tickets', 'orders', 'invoices', 'invoice-details', 'drivers', 'drivers-me', 'suppliers', 'products', 'deliveries', 'dispatch-board'
    const status = url.searchParams.get('status');
    const limit = parseInt(url.searchParams.get('limit') || '50');
    const page = parseInt(url.searchParams.get('page') || '1');
    const offset = (page - 1) * limit;

    // Handle drivers-me self lookup
    if (resource === 'drivers-me') {
      const userId = decodedPayload.id || decodedPayload.userId;
      if (!userId) {
        return new Response(
          JSON.stringify({ error: 'User ID missing from token' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const { data: driver, error } = await supabaseClient
        .from('Driver')
        .select(`
          id, name, type, phone, email, active, ratePerDelivery, ratePerTrip, userId, companyName,
          deliveries:Delivery(
            id, status, createdAt,
            order:Order(id, spruceOrderId, customerName, product, quantity, unit)
          )
        `)
        .eq('userId', userId)
        .single();

      if (error) {
        return new Response(
          JSON.stringify({ error: error.message }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      // Mobile view fetches active deliveries (not completed/cancelled) plus completed today
      const todayDeliveries = (driver.deliveries || []).filter((d: any) => 
        d.status !== 'DELIVERED' && d.status !== 'CANCELLED' || new Date(d.createdAt) >= today
      );
      const completedDeliveries = todayDeliveries.filter((d: any) => d.status === 'DELIVERED');
      const currentTask = todayDeliveries.find((d: any) => 
        ['PLACED', 'OUT_FOR_DELIVERY', 'IN_TRANSIT', 'ON_HOLD', 'DELAYED'].includes(d.status)
      );

      const responseData = {
        id: driver.id,
        name: driver.name,
        type: driver.type,
        phone: driver.phone,
        email: driver.email,
        active: driver.active,
        ratePerDelivery: driver.ratePerDelivery ? Number(driver.ratePerDelivery) : 0,
        ratePerTrip: driver.ratePerTrip ? Number(driver.ratePerTrip) : 0,
        userId: driver.userId,
        companyName: driver.companyName,
        stats: {
          totalToday: todayDeliveries.length,
          completedToday: completedDeliveries.length,
          progress: todayDeliveries.length > 0 ? Math.round((completedDeliveries.length / todayDeliveries.length) * 100) : 0
        },
        currentTask: currentTask || null
      };

      return new Response(
        JSON.stringify(responseData),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Handle high-level dispatch board resource
    if (resource === 'dispatch-board') {
      const { data: drivers, error: err1 } = await supabaseClient
        .from('Driver')
        .select(`
          id, name, type, phone, email, active, ratePerDelivery, ratePerTrip, userId, companyName,
          deliveries:Delivery(
            id, orderId, driverId, status, priority, startedAt, completedAt, pickupPhotoUrl, deliveryPhotoUrl, createdAt,
            order:Order(id, spruceOrderId, customerName, product, quantity, unit, orderDate, deliveryStatus, priority),
            history:DeliveryHistory(id, status, notes, createdAt)
          )
        `)
        .eq('active', true)
        .order('name', { ascending: true });

      const { data: unassignedOrders, error: err2 } = await supabaseClient
        .from('Order')
        .select(`
          id, spruceOrderId, poNumber, customerName, buyerType, product, quantity, unit, supplierId, orderDate, deliveryDate, hasInvoice, invoiceNumber, createdAt, deliveryStatus, driverId, priority
        `)
        .is('driverId', null)
        .order('createdAt', { ascending: false });

      if (err1 || err2) {
        return new Response(
          JSON.stringify({ error: err1?.message || err2?.message }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      return new Response(
        JSON.stringify({ drivers: drivers || [], unassignedOrders: unassignedOrders || [] }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Handle invoice details fetch
    if (resource === 'invoice-details') {
      const id = url.searchParams.get('id');
      if (!id) {
        return new Response(
          JSON.stringify({ error: 'Missing invoice id parameter' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const { data: invoice, error } = await supabaseClient
        .from('Invoice')
        .select(`
          id, invoiceNumber, senderType, supplierId, invoiceDate, dueDate, totalAmount, currency, fileUrl, emailFrom, emailSubject, gmailMessageId, status, verifiedById, verifiedAt, disputeNote, receivedAt, OcrJobStatus,
          supplier:Supplier(id, name),
          lineItems:InvoiceLineItem(
            id, lineNumber, poNumber, description, quantity, unit, unitRate, lineTotal, matchedOrderId, negotiatedRate, rateDiscrepancy, qtyDiscrepancy, approvedTotal, flag, isOverridden, overrideNote,
            matchedOrder:Order(
              id, spruceOrderId, customerName, product, quantity, unit,
              deliveries:Delivery(
                id, status, pickupPhotoUrl, deliveryPhotoUrl,
                driver:Driver(id, name)
              )
            ),
            matchedTickets:Ticket(
              id, ticketNumber, imageUrl, quantity, unit, spruceMatched
            )
          )
        `)
        .eq('id', id)
        .single();

      if (error) {
        return new Response(
          JSON.stringify({ error: error.message }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      return new Response(
        JSON.stringify(invoice),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    let query: any;
    if (resource === 'tickets') {
      query = supabaseClient
        .from('Ticket')
        .select(`
          id, ticketNumber, source, supplierId, poNumber, material, quantity, unit, rateOnTicket, ticketDate, imageUrl, ocrConfidence, linkedOrderId, linkMethod, linkedById, status, receivedAt, driverId, deliveryStatus, spruceMatched,
          supplier:Supplier(id, name),
          driver:Driver(id, name)
        `, { count: 'exact' })
        .order('receivedAt', { ascending: false });
    } else if (resource === 'orders') {
      query = supabaseClient
        .from('Order')
        .select(`
          id, spruceOrderId, poNumber, customerName, buyerType, product, quantity, unit, supplierId, orderDate, deliveryDate, hasInvoice, invoiceNumber, createdAt, deliveryStatus, driverId, priority,
          supplier:Supplier(id, name),
          ticketMatches:TicketOrderMatch(
            id,
            ticket:Ticket(id, ticketNumber, imageUrl)
          )
        `, { count: 'exact' })
        .order('orderDate', { ascending: false });
    } else if (resource === 'invoices') {
      query = supabaseClient
        .from('Invoice')
        .select(`
          id, invoiceNumber, senderType, supplierId, invoiceDate, dueDate, totalAmount, currency, fileUrl, emailFrom, emailSubject, gmailMessageId, status, verifiedById, verifiedAt, disputeNote, receivedAt, OcrJobStatus,
          supplier:Supplier(id, name),
          lineItems:InvoiceLineItem(id, flag, rateDiscrepancy)
        `, { count: 'exact' })
        .order('receivedAt', { ascending: false });
    } else if (resource === 'drivers') {
      // For list drivers, we fetch with deliveries so we can compute currentTask and progress stats
      const { data, count, error } = await supabaseClient
        .from('Driver')
        .select(`
          id, name, type, phone, email, active, ratePerDelivery, ratePerTrip, userId, companyName,
          deliveries:Delivery(
            id, status, createdAt,
            order:Order(id, spruceOrderId, customerName)
          )
        `, { count: 'exact' })
        .eq('active', true)
        .order('name', { ascending: true });

      if (error) {
        return new Response(
          JSON.stringify({ error: error.message }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const transformedData = (data || []).map((driver: any) => {
        const todayDeliveries = (driver.deliveries || []).filter((d: any) => new Date(d.createdAt) >= today);
        const completedDeliveries = todayDeliveries.filter((d: any) => d.status === 'DELIVERED');
        const currentTask = todayDeliveries.find((d: any) => 
          ['PLACED', 'OUT_FOR_DELIVERY', 'IN_TRANSIT', 'ON_HOLD', 'DELAYED'].includes(d.status)
        );

        return {
          id: driver.id,
          name: driver.name,
          type: driver.type,
          phone: driver.phone,
          email: driver.email,
          active: driver.active,
          ratePerDelivery: driver.ratePerDelivery ? Number(driver.ratePerDelivery) : 0,
          ratePerTrip: driver.ratePerTrip ? Number(driver.ratePerTrip) : 0,
          userId: driver.userId,
          companyName: driver.companyName,
          stats: {
            totalToday: todayDeliveries.length,
            completedToday: completedDeliveries.length,
            progress: todayDeliveries.length > 0 ? Math.round((completedDeliveries.length / todayDeliveries.length) * 100) : 0
          },
          currentTask: currentTask || null
        };
      });

      return new Response(
        JSON.stringify({
          data: transformedData,
          pagination: {
            page,
            limit,
            totalPages: count ? Math.ceil(count / limit) : 1,
            totalCount: count || 0
          }
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    } else if (resource === 'suppliers') {
      query = supabaseClient
        .from('Supplier')
        .select(`
          id, name, contactEmail, phone, address,
          negotiatedRates:NegotiatedRate(
            id,
            supplierId,
            productName,
            rate,
            unit,
            effectiveFrom,
            effectiveTo,
            notes,
            createdAt
          )
        `, { count: 'exact' })
        .order('name', { ascending: true });
    } else if (resource === 'products') {
      query = supabaseClient
        .from('Product')
        .select(`
          id, name, unit, createdAt
        `, { count: 'exact' })
        .order('name', { ascending: true });
    } else if (resource === 'deliveries') {
      const driverId = url.searchParams.get('driverId');
      query = supabaseClient
        .from('Delivery')
        .select(`
          id, orderId, driverId, status, priority, startedAt, completedAt, pickupPhotoUrl, deliveryPhotoUrl, createdAt,
          order:Order(id, spruceOrderId, customerName, product, quantity, unit, createdAt),
          driver:Driver(id, name),
          history:DeliveryHistory(id, status, notes, createdAt)
        `, { count: 'exact' })
        .order('createdAt', { ascending: false });
      
      if (driverId) {
        query = query.eq('driverId', driverId);
      }
    } else {
      return new Response(
        JSON.stringify({ error: 'Invalid resource. Supported resources: tickets, orders, invoices, invoice-details, drivers, suppliers, products, deliveries, dispatch-board' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Apply basic filter if status parameter is passed
    if (status) {
      query = query.eq('status', status);
    }

    // Apply pagination ranges
    const { data, count, error } = await query.range(offset, offset + limit - 1);

    if (error) {
      return new Response(
        JSON.stringify({ error: error.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({
        data,
        pagination: {
          page,
          limit,
          totalPages: count ? Math.ceil(count / limit) : 1,
          totalCount: count || 0
        }
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    return new Response(
      JSON.stringify({ error: error.message || 'Unexpected error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
})

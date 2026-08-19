// @ts-nocheck
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.0"
import { canAccessResource, requiresOwnDriverScope, sessionFromUserRecord } from "../_shared/accessPolicy.ts"
import { businessDayOf, businessDayRange } from "../_shared/businessDay.ts"

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

    // Parse and validate time-based claims. Signature verification alone must
    // not keep expired or not-yet-valid sessions alive indefinitely.
    const decodedPayload = atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/"));
    const payload = JSON.parse(decodedPayload);
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp <= now) return null;
    if (typeof payload.nbf === 'number' && payload.nbf > now + 30) return null;
    if (!payload.id || !payload.role) return null;
    return payload;
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
    const jwtSecret = Deno.env.get('JWT_SECRET');
    if (!supabaseUrl || !supabaseServiceKey || !jwtSecret) {
      return new Response(
        JSON.stringify({ error: 'Service configuration unavailable' }),
        { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

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

    const tokenUserId = decodedPayload.id || decodedPayload.userId;
    if (!tokenUserId) {
      return new Response(
        JSON.stringify({ error: 'User ID missing from token' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Re-read the live account. The token role/active claims are not trusted
    // past this point — same rule Express already applies.
    const { data: currentUser, error: currentUserError } = await supabaseClient
      .from('User')
      .select('id, email, role, active')
      .eq('id', tokenUserId)
      .maybeSingle();

    if (currentUserError) {
      return new Response(
        JSON.stringify({ error: currentUserError.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const session = sessionFromUserRecord(currentUser);
    if (!session) {
      return new Response(
        JSON.stringify({ error: 'Account is inactive' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const url = new URL(req.url);
    const resource = url.searchParams.get('resource'); // 'dashboard-summary', 'tickets', 'orders', 'invoices', 'invoice-details', 'drivers', 'drivers-me', 'suppliers', 'products', 'deliveries', 'dispatch-board'
    const status = url.searchParams.get('status');
    const limit = parseInt(url.searchParams.get('limit') || '50');
    const page = parseInt(url.searchParams.get('page') || '1');
    const offset = (page - 1) * limit;

    if (!canAccessResource(session.role, resource)) {
      return new Response(
        JSON.stringify({ error: 'Forbidden' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // A DRIVER may read deliveries, but only its own. The scope is resolved
    // from the verified token subject; any caller-supplied driverId is ignored
    // so one driver cannot enumerate another driver's route.
    let enforcedDriverId: string | null = null;
    if (requiresOwnDriverScope(session.role, resource)) {
      const sessionUserId = session.id;
      if (!sessionUserId) {
        return new Response(
          JSON.stringify({ error: 'User ID missing from token' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const { data: ownDriver, error: ownDriverError } = await supabaseClient
        .from('Driver')
        .select('id')
        .eq('userId', sessionUserId)
        .maybeSingle();

      if (ownDriverError) {
        return new Response(
          JSON.stringify({ error: ownDriverError.message }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      if (!ownDriver) {
        return new Response(
          JSON.stringify({ error: 'No driver profile is linked to this account' }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      enforcedDriverId = ownDriver.id;
    }

    // Keep the dashboard payload small. Previously the browser downloaded up to
    // 1,000 invoices (including every line-item flag) plus every supplier and
    // negotiated rate just to render three counters and five recent rows.
    if (resource === 'dashboard-summary') {
      const now = new Date();
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

      const [recentResult, pendingResult, disputedResult, monthlyResult] = await Promise.all([
        supabaseClient
          .from('Invoice')
          .select(`
            id, invoiceNumber, invoiceDate, totalAmount, currency, status, receivedAt,
            supplier:Supplier(id, name)
          `)
          .order('receivedAt', { ascending: false, nullsFirst: false })
          .limit(5),
        supabaseClient
          .from('Invoice')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'PENDING_REVIEW'),
        supabaseClient
          .from('Invoice')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'DISPUTED'),
        supabaseClient
          .from('Invoice')
          .select('id', { count: 'exact', head: true })
          .gte('receivedAt', monthStart),
      ]);

      const queryError = recentResult.error || pendingResult.error || disputedResult.error || monthlyResult.error;
      if (queryError) {
        return new Response(
          JSON.stringify({ error: queryError.message }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      return new Response(
        JSON.stringify({
          recentInvoices: recentResult.data || [],
          stats: {
            pendingCount: pendingResult.count || 0,
            disputedCount: disputedResult.count || 0,
            totalMonthly: monthlyResult.count || 0,
            savingsDetected: 0,
          },
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Handle drivers-me self lookup
    if (resource === 'drivers-me') {
      const userId = session.id;
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
            order:Order(id, spruceOrderId, customerName, shippingAddress, product, quantity, unit, tickets:Ticket(id, ticketNumber, imageUrl, thumbnailUrl, status, driverId))
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
      // The board describes one business day. `?date=` defaults to today in the
      // yard, and both queries below are bounded by it.
      const requestedDay = url.searchParams.get('date') || businessDayOf();
      const dayRange = businessDayRange(requestedDay);
      if (!dayRange) {
        return new Response(
          JSON.stringify({ error: `Invalid date parameter: ${requestedDay}` }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Embedded deliveries are bounded to the work this board is about: still
      // open, or completed on the day being viewed. Without this the board
      // pulled every delivery each driver has ever had — each with its order
      // and its full status history — and did so again on every 10s refresh.
      // That is the largest single contributor to how slow this screen feels.
      //
      // Completed-on-the-day is kept rather than dropped so the "completed"
      // counter on each driver row still means something.
      //
      // This mirrors DispatchService.getDispatchBoard, which applies the same
      // two conditions in Prisma.
      //
      // NOTE: this embedded `or` filter is the one line in this change that was
      // not executed against a live PostgREST. If the syntax is rejected the
      // response is a visible 400 handled below, never silently wrong data. To
      // revert, delete the `.or(...)` line — the board returns to unbounded.
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
        .or(
          `status.not.in.(DELIVERED,CANCELLED),completedAt.gte.${dayRange.gte}`,
          { foreignTable: 'deliveries' }
        )
        .order('name', { ascending: true });

      // The unassigned pool used to return every order ever imported that had
      // never been assigned, so it only grew and today's work sat below months
      // of stale rows.
      const { data: unassignedOrders, error: err2 } = await supabaseClient
        .from('Order')
        .select(`
          id, spruceOrderId, poNumber, customerName, buyerType, product, quantity, unit, supplierId, orderDate, deliveryDate, hasInvoice, invoiceNumber, createdAt, deliveryStatus, driverId, priority
        `)
        .is('driverId', null)
        .gte('createdAt', dayRange.gte)
        .lt('createdAt', dayRange.lt)
        .order('createdAt', { ascending: false });

      if (err1 || err2) {
        return new Response(
          JSON.stringify({ error: err1?.message || err2?.message }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // `date` is echoed so the board can show which day it is looking at
      // rather than assuming its own clock agrees with the server's.
      return new Response(
        JSON.stringify({
          date: requestedDay,
          drivers: drivers || [],
          unassignedOrders: unassignedOrders || [],
        }),
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

    const search = url.searchParams.get('search');
    const supplierId = url.searchParams.get('supplierId');
    const source = url.searchParams.get('source');
    const startDate = url.searchParams.get('startDate');
    const endDate = url.searchParams.get('endDate');

    let query: any;
    if (resource === 'tickets') {
      query = supabaseClient
        .from('Ticket')
        .select(`
          id, ticketNumber, source, supplierId, poNumber, material, quantity, unit, rateOnTicket, ticketDate, imageUrl, thumbnailUrl, ocrConfidence, linkedOrderId, linkMethod, linkedById, status, receivedAt, driverId, deliveryStatus, spruceMatched,
          supplier:Supplier(id, name),
          driver:Driver(id, name)
        `, { count: 'exact' })
        .order('receivedAt', { ascending: false });

      if (status) {
        query = query.eq('status', status);
      }
      if (supplierId) {
        query = query.eq('supplierId', supplierId);
      }
      if (source) {
        query = query.eq('source', source);
      }
      if (startDate) {
        query = query.gte('receivedAt', `${startDate}T00:00:00.000Z`);
      }
      if (endDate) {
        query = query.lte('receivedAt', `${endDate}T23:59:59.999Z`);
      }
      if (search && search.trim()) {
        const s = search.trim();
        query = query.or(`ticketNumber.ilike.%${s}%,poNumber.ilike.%${s}%,material.ilike.%${s}%`);
      }
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

      if (status) {
        query = query.eq('deliveryStatus', status);
      }
      if (supplierId) {
        query = query.eq('supplierId', supplierId);
      }
      if (search && search.trim()) {
        const s = search.trim();
        query = query.or(`spruceOrderId.ilike.%${s}%,poNumber.ilike.%${s}%,customerName.ilike.%${s}%,product.ilike.%${s}%`);
      }
    } else if (resource === 'invoices') {
      query = supabaseClient
        .from('Invoice')
        .select(`
          id, invoiceNumber, senderType, supplierId, invoiceDate, dueDate, totalAmount, currency, fileUrl, emailFrom, emailSubject, gmailMessageId, status, verifiedById, verifiedAt, disputeNote, receivedAt, OcrJobStatus,
          supplier:Supplier(id, name),
          lineItems:InvoiceLineItem(id, flag, rateDiscrepancy)
        `, { count: 'exact' })
        .order('receivedAt', { ascending: false, nullsFirst: false })
        .order('invoiceDate', { ascending: false, nullsFirst: false });

      if (status) {
        query = query.eq('status', status);
      }
      if (supplierId) {
        query = query.eq('supplierId', supplierId);
      }
      if (search && search.trim()) {
        const s = search.trim();
        query = query.or(`invoiceNumber.ilike.%${s}%,emailFrom.ilike.%${s}%`);
      }
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
          id, name, type, contactName, contactEmail, phone, address, emailDomains, keywords, active,
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
      // enforcedDriverId is set for driver sessions and always wins over the
      // query parameter. Operations roles keep the existing filter behaviour.
      const driverId = enforcedDriverId ?? url.searchParams.get('driverId');
      query = supabaseClient
        .from('Delivery')
        .select(`
          id, orderId, driverId, status, priority, startedAt, completedAt, pickupPhotoUrl, deliveryPhotoUrl, createdAt,
          order:Order(id, spruceOrderId, customerName, shippingAddress, product, quantity, unit, createdAt, tickets:Ticket(id, ticketNumber, imageUrl, thumbnailUrl, status, driverId)),
          driver:Driver(id, name),
          history:DeliveryHistory(id, status, notes, createdAt)
        `, { count: 'exact' });

      if (enforcedDriverId) {
        // A driver sees one stop: the next open one by dispatch priority.
        //
        // The rule existed only in the browser — the whole route was fetched
        // and every row but the first was hidden with CSS. Dispatch reorders
        // the queue while a driver is out, so the hidden rows were both stale
        // and none of the driver's business; anyone opening devtools saw the
        // customers, products and quantities for the rest of the day.
        //
        // `count: 'exact'` still reports how many stops remain, so the app can
        // show progress without holding the route.
        query = query
          .not('status', 'in', '("DELIVERED","CANCELLED")')
          .order('priority', { ascending: true });
      } else {
        query = query.order('createdAt', { ascending: false });
      }

      if (driverId) {
        query = query.eq('driverId', driverId);
      }
    } else {
      return new Response(
        JSON.stringify({ error: 'Invalid resource. Supported resources: dashboard-summary, tickets, orders, invoices, invoice-details, drivers, suppliers, products, deliveries, dispatch-board' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Apply basic filter if status parameter is passed
    if (status) {
      query = query.eq('status', status);
    }

    // Apply pagination ranges. A driver reading deliveries gets exactly one row
    // regardless of what the caller asked for, so a hand-edited `limit` cannot
    // widen the single-stop rule back out to the whole route.
    const singleStop = resource === 'deliveries' && Boolean(enforcedDriverId);
    const rangeStart = singleStop ? 0 : offset;
    const rangeEnd = singleStop ? 0 : offset + limit - 1;

    const { data, count, error } = await query.range(rangeStart, rangeEnd);

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

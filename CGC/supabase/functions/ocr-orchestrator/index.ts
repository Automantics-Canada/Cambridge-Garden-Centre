// @ts-nocheck
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

serve(async (req) => {
  try {
    const webhookSecret = Deno.env.get("OCR_WEBHOOK_SECRET")
    const suppliedSecret = req.headers.get("x-webhook-secret")
    if (!webhookSecret || suppliedSecret !== webhookSecret) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      )
    }

    const payload = await req.json()

    const jobId = payload.record?.id
    const jobType = payload.record?.type // E.g., 'INVOICE'

    if (jobType === 'INVOICE' && jobId) {
      const backendUrl = Deno.env.get("BACKEND_URL")
      const sharedSecret = Deno.env.get("INTERNAL_SHARED_SECRET")

      if (!backendUrl || !sharedSecret) {
        console.error("[ORCHESTRATOR] Required service configuration is missing.")
        return new Response(
          JSON.stringify({ error: "Service configuration unavailable" }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        )
      }

      const targetUrl = `${backendUrl}/api/internal/process-ocr/${jobId}`
      console.log(`[ORCHESTRATOR] Instantly forwarding invoice OCR job ${jobId} to ${targetUrl}`)

      const response = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sharedSecret}`
        }
      })

      const status = response.status
      await response.body?.cancel()
      console.log(`[ORCHESTRATOR] Backend responded with status ${status}`)

      return new Response(
        JSON.stringify({ success: response.ok, backendStatus: status }),
        { headers: { "Content-Type": "application/json" } }
      )
    }

    return new Response(
      JSON.stringify({ success: true, message: "Ignored (non-invoice job or missing jobId)" }),
      { headers: { "Content-Type": "application/json" } }
    )
  } catch (err: any) {
    console.error("[ORCHESTRATOR] Unexpected error processing request:", err)
    return new Response(
      JSON.stringify({ error: err.message || "Unexpected error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    )
  }
})

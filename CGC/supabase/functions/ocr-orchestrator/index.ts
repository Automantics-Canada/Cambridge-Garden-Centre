// @ts-nocheck
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

serve(async (req) => {
  try {
    const payload = await req.json()
    console.log("[ORCHESTRATOR] Received event payload:", JSON.stringify(payload))

    const jobId = payload.record?.id
    const jobType = payload.record?.type // E.g., 'INVOICE'

    if (jobType === 'INVOICE' && jobId) {
      const backendUrl = Deno.env.get("BACKEND_URL")
      const sharedSecret = Deno.env.get("INTERNAL_SHARED_SECRET")

      if (!backendUrl) {
        console.error("[ORCHESTRATOR] Error: BACKEND_URL environment variable is not defined.")
        return new Response(
          JSON.stringify({ error: "BACKEND_URL is not set" }),
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
      const responseText = await response.text()
      console.log(`[ORCHESTRATOR] Backend responded with status ${status}: ${responseText}`)

      return new Response(
        JSON.stringify({ success: true, backendStatus: status, details: responseText }),
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

// @ts-nocheck
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts"
import { isServiceRoleBearer } from "../_shared/serviceRole.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  // Handle CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // The only caller is the Express driver-create path, which already sends
    // the service-role key. The published anon key is a valid project JWT, so
    // gateway verify_jwt is not enough — require the service-role secret.
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
    if (!isServiceRoleBearer(req.headers.get("Authorization"), serviceRoleKey)) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      })
    }

    const { email, name, password } = await req.json()

    if (!email || !name || !password) {
      throw new Error("Missing email, name, or password")
    }

    const gmailUser = Deno.env.get("GMAIL_USER")
    const gmailPass = Deno.env.get("GMAIL_PASS")
    const frontendUrl = Deno.env.get("FRONTEND_URL") || "http://localhost:5173"

    if (!gmailUser || !gmailPass) {
      throw new Error("SMTP credentials GMAIL_USER or GMAIL_PASS are not set")
    }

    console.log(`[CREDENTIALS] Sending email to ${email}...`)

    const client = new SMTPClient({
      connection: {
        hostname: "smtp.gmail.com",
        port: 465,
        tls: true,
        auth: {
          username: gmailUser,
          password: gmailPass,
        },
      },
    })

    const html = `
      <div style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; color: #1a1a1a;">
        <div style="text-align: center; margin-bottom: 30px;">
          <div style="display: inline-block; background: #2D6A4F; color: white; padding: 10px 20px; border-radius: 12px; font-weight: 800; font-size: 14px; letter-spacing: 1px; text-transform: uppercase;">
            CGC Logistics
          </div>
        </div>
        
        <h1 style="font-size: 24px; font-weight: 900; margin-bottom: 8px; color: #111; letter-spacing: -0.5px; text-align: center;">Welcome, ${name}!</h1>
        <p style="font-size: 16px; line-height: 1.6; color: #555; margin-bottom: 30px; text-align: center;">
          Your driver account has been created successfully. Below are your login credentials to access the CGC Driver Portal.
        </p>

        <div style="background: #f8f9fa; border: 1px solid #edf2f7; border-radius: 20px; padding: 24px; margin-bottom: 30px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05);">
          <div style="margin-bottom: 16px; border-bottom: 1px solid #edf2f7; padding-bottom: 12px;">
            <p style="font-size: 10px; font-weight: 800; color: #a0aec0; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 4px 0;">Login Link</p>
            <p style="font-size: 15px; font-weight: 600; color: #2D6A4F; margin: 0;"><a href="${frontendUrl}/login" style="color: #2D6A4F; text-decoration: none;">${frontendUrl}/login</a></p>
          </div>
          <div style="margin-bottom: 16px;">
            <p style="font-size: 10px; font-weight: 800; color: #a0aec0; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 4px 0;">Username / Email</p>
            <p style="font-size: 16px; font-weight: 700; color: #2d3748; margin: 0;">${email}</p>
          </div>
          <div>
            <p style="font-size: 10px; font-weight: 800; color: #a0aec0; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 4px 0;">Password</p>
            <p style="font-size: 16px; font-weight: 700; color: #2d3748; margin: 0; font-family: monospace; background: #e2e8f0; padding: 6px 12px; border-radius: 8px; display: inline-block;">${password}</p>
          </div>
        </div>

        <div style="text-align: center; margin-bottom: 40px;">
          <a href="${frontendUrl}/login" style="display: inline-block; background: #2D6A4F; color: white; padding: 18px 36px; border-radius: 16px; font-weight: 800; text-decoration: none; font-size: 16px; box-shadow: 0 10px 15px -3px rgba(45, 106, 79, 0.3);">
            LOG IN TO PORTAL
          </a>
        </div>

        <hr style="border: 0; border-top: 1px solid #edf2f7; margin-bottom: 30px;">
        
        <p style="font-size: 13px; color: #a0aec0; text-align: center; line-height: 1.6;">
          For security, please change your password or keep this email safe.<br>
          <strong>CGC Dispatch Team</strong>
        </p>
      </div>
    `

    await client.send({
      from: `CGC Dispatch <${gmailUser}>`,
      to: email,
      subject: "🚚 Welcome to CGC! Your Driver Portal Credentials",
      content: "Please see the HTML content to access your portal credentials.",
      html: html,
    })

    console.log(`[CREDENTIALS] Email sent to ${email} successfully!`)

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    })

  } catch (error: any) {
    console.error(`[CREDENTIALS] Error:`, error)
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    })
  }
})

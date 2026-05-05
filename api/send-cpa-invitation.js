// Send CPA Client Invitation Email
// Triggered when CPA clicks "Invite Client" in CPA dashboard
// Sends formatted email to client with magic link to accept invitation

const RESEND_API_KEY = process.env.RESEND_API_KEY;

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { 
      client_email, 
      client_name, 
      cpa_firm_name, 
      cpa_email, 
      invitation_url 
    } = req.body;

    if (!client_email || !invitation_url || !cpa_firm_name) {
      return res.status(400).json({ 
        error: 'Missing required fields: client_email, invitation_url, cpa_firm_name' 
      });
    }

    if (!RESEND_API_KEY) {
      console.error('RESEND_API_KEY not configured');
      return res.status(500).json({ error: 'Email service not configured' });
    }

    const greetingName = client_name ? client_name.split(' ')[0] : 'there';

    // Email HTML body
    const htmlBody = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
      background: #f5f5f5; 
      margin: 0; 
      padding: 0; 
      color: #333;
    }
    .container { 
      max-width: 600px; 
      margin: 40px auto; 
      background: #ffffff; 
      border-radius: 12px; 
      overflow: hidden;
      box-shadow: 0 2px 8px rgba(0,0,0,0.08);
    }
    .header { 
      background: #00d68f; 
      color: #000; 
      padding: 32px 40px; 
      text-align: center;
    }
    .header h1 { 
      margin: 0; 
      font-size: 28px; 
      font-weight: 700;
    }
    .content { 
      padding: 40px;
      line-height: 1.6;
    }
    .content h2 { 
      margin: 0 0 16px; 
      font-size: 22px;
      color: #111;
    }
    .content p { 
      margin: 0 0 16px; 
      font-size: 16px;
      color: #444;
    }
    .button-container {
      text-align: center;
      margin: 32px 0;
    }
    .button { 
      display: inline-block;
      background: #00d68f; 
      color: #000 !important; 
      padding: 14px 32px; 
      border-radius: 8px; 
      text-decoration: none; 
      font-weight: 600;
      font-size: 16px;
    }
    .info-box {
      background: #f9f9f9;
      border-left: 3px solid #00d68f;
      padding: 16px 20px;
      margin: 24px 0;
      border-radius: 4px;
    }
    .info-box p { 
      margin: 0; 
      font-size: 14px;
      color: #666;
    }
    .footer { 
      padding: 24px 40px; 
      background: #fafafa; 
      text-align: center; 
      color: #888; 
      font-size: 13px;
      border-top: 1px solid #eee;
    }
    .footer p { margin: 4px 0; }
    .link-fallback {
      word-break: break-all;
      color: #888;
      font-size: 12px;
      margin-top: 24px;
      padding-top: 16px;
      border-top: 1px solid #eee;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>WealthRx</h1>
    </div>
    
    <div class="content">
      <h2>Hi ${escapeHtml(greetingName)},</h2>
      
      <p><strong>${escapeHtml(cpa_firm_name)}</strong> has invited you to use WealthRx for your bookkeeping.</p>
      
      <p>WealthRx is an AI-powered bookkeeping platform that connects to your bank accounts and automatically categorizes your transactions for tax purposes. Your accountant will use it to manage your books faster and more accurately.</p>
      
      <div class="button-container">
        <a href="${escapeHtml(invitation_url)}" class="button">Accept Invitation</a>
      </div>
      
      <div class="info-box">
        <p><strong>What happens next:</strong></p>
        <p>1. Click the button above to set up your account<br>
        2. Securely connect your bank accounts via Plaid<br>
        3. Your accountant will handle the bookkeeping</p>
      </div>
      
      <p>This invitation was sent by your accountant. If you weren't expecting this, you can safely ignore this email.</p>
      
      <div class="link-fallback">
        Button not working? Copy and paste this link into your browser:<br>
        ${escapeHtml(invitation_url)}
      </div>
    </div>
    
    <div class="footer">
      <p><strong>WealthRx</strong></p>
      <p>AI-powered bookkeeping for accountants and small businesses</p>
      <p>Sent on behalf of ${escapeHtml(cpa_firm_name)}${cpa_email ? ' • ' + escapeHtml(cpa_email) : ''}</p>
    </div>
  </div>
</body>
</html>
    `.trim();

    // Plain text fallback
    const textBody = `
Hi ${greetingName},

${cpa_firm_name} has invited you to use WealthRx for your bookkeeping.

WealthRx is an AI-powered bookkeeping platform that connects to your bank accounts and automatically categorizes your transactions for tax purposes. Your accountant will use it to manage your books faster and more accurately.

Accept your invitation here:
${invitation_url}

What happens next:
1. Click the link above to set up your account
2. Securely connect your bank accounts via Plaid
3. Your accountant will handle the bookkeeping

This invitation was sent by your accountant. If you weren't expecting this, you can safely ignore this email.

—
WealthRx
AI-powered bookkeeping for accountants and small businesses
Sent on behalf of ${cpa_firm_name}
    `.trim();

    // Send via Resend - using verified wealthrx.ai domain
    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'WealthRx <invitations@wealthrx.ai>',
        to: [client_email],
        reply_to: cpa_email || undefined,
        subject: `${cpa_firm_name} invited you to WealthRx`,
        html: htmlBody,
        text: textBody
      })
    });

    if (!resendRes.ok) {
      const errText = await resendRes.text();
      console.error('Resend API error:', errText);
      return res.status(500).json({ 
        error: 'Failed to send email', 
        details: errText 
      });
    }

    const resendData = await resendRes.json();

    return res.status(200).json({ 
      success: true, 
      message: 'Invitation email sent',
      email_id: resendData.id
    });

  } catch (error) {
    console.error('Send CPA invitation error:', error.message);
    return res.status(500).json({ 
      error: 'Server error', 
      details: error.message 
    });
  }
};

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

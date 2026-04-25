// This file receives a webhook from Supabase when a new profile is created
// Sends an email alert to salman@wealthrx.ai via Resend

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Verify webhook came from Supabase (optional security check)
    var authHeader = req.headers.authorization;
    var expectedSecret = process.env.WEBHOOK_SECRET;
    if (expectedSecret && authHeader !== 'Bearer ' + expectedSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Supabase sends the new row in req.body.record
    var record = req.body.record;
    if (!record) {
      return res.status(400).json({ error: 'No record in webhook payload' });
    }

    var email = record.email || 'unknown';
    var fullName = record.full_name || 'No name provided';
    var businessName = record.business_name || 'No business name';
    var waitlistPosition = record.waitlist_position || 'N/A';
    var approved = record.approved || false;
    var userId = record.id || '';

    // Build the email HTML
    var emailHtml = 
      '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">' +
        '<div style="background:linear-gradient(135deg,#0D7C5F,#10A37F);padding:30px;border-radius:12px;color:white;text-align:center;">' +
          '<h1 style="margin:0;font-size:28px;">🎉 New WealthRx Signup!</h1>' +
          '<p style="margin:10px 0 0;opacity:0.9;">Someone just joined your waitlist</p>' +
        '</div>' +
        '<div style="background:#f9f9f9;padding:24px;border-radius:12px;margin-top:20px;">' +
          '<h2 style="margin:0 0 16px;color:#0D7C5F;font-size:20px;">User Details</h2>' +
          '<table style="width:100%;border-collapse:collapse;">' +
            '<tr><td style="padding:8px 0;color:#666;width:140px;"><strong>Name:</strong></td><td style="padding:8px 0;">' + fullName + '</td></tr>' +
            '<tr><td style="padding:8px 0;color:#666;"><strong>Email:</strong></td><td style="padding:8px 0;"><a href="mailto:' + email + '" style="color:#10A37F;">' + email + '</a></td></tr>' +
            '<tr><td style="padding:8px 0;color:#666;"><strong>Business:</strong></td><td style="padding:8px 0;">' + businessName + '</td></tr>' +
            '<tr><td style="padding:8px 0;color:#666;"><strong>Waitlist Position:</strong></td><td style="padding:8px 0;font-weight:bold;color:#10A37F;">#' + waitlistPosition + '</td></tr>' +
            '<tr><td style="padding:8px 0;color:#666;"><strong>Status:</strong></td><td style="padding:8px 0;">' + (approved ? '✅ Approved' : '⏳ Pending Approval') + '</td></tr>' +
            '<tr><td style="padding:8px 0;color:#666;"><strong>User ID:</strong></td><td style="padding:8px 0;font-family:monospace;font-size:12px;color:#999;">' + userId + '</td></tr>' +
          '</table>' +
        '</div>' +
        '<div style="background:#fff;border:1px solid #e0e0e0;padding:24px;border-radius:12px;margin-top:20px;">' +
          '<h3 style="margin:0 0 12px;color:#333;">Quick Actions</h3>' +
          '<p style="color:#666;margin:8px 0;font-size:14px;">To approve this user, run this SQL in Supabase:</p>' +
          '<div style="background:#f5f5f5;padding:12px;border-radius:6px;font-family:monospace;font-size:12px;color:#333;margin:12px 0;">UPDATE profiles SET approved = true WHERE email = \'' + email + '\';</div>' +
          '<p style="color:#666;margin:12px 0 0;font-size:13px;">Or approve them in the Supabase Table Editor by finding their row and toggling the approved column to true.</p>' +
        '</div>' +
        '<div style="text-align:center;margin-top:24px;padding-top:20px;border-top:1px solid #e0e0e0;color:#999;font-size:12px;">' +
          'WealthRx AI LLC · Signup alerts · <a href="https://app.wealthrx.ai" style="color:#10A37F;">Open Dashboard</a>' +
        '</div>' +
      '</div>';

    // Send email via Resend
    var emailResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'WealthRx Alerts <alerts@wealthrx.ai>',
        to: ['salman@wealthrx.ai'],
        subject: '🚨 New WealthRx signup: ' + fullName + ' (' + email + ')',
        html: emailHtml
      })
    });

    var emailData = await emailResponse.json();

    if (!emailResponse.ok) {
      console.error('Resend error:', emailData);
      return res.status(500).json({ error: 'Email send failed', details: emailData });
    }

    console.log('Signup alert sent for:', email);
    res.status(200).json({ success: true, emailId: emailData.id });
  } catch (error) {
    console.error('Webhook handler error:', error.message);
    res.status(500).json({ error: 'Handler failed', details: error.message });
  }
};

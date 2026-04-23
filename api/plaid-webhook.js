var plaidModule = require('plaid');
var supabaseModule = require('@supabase/supabase-js');
var anthropicModule = require('@anthropic-ai/sdk');

var PlaidApi = plaidModule.PlaidApi;
var Configuration = plaidModule.Configuration;
var PlaidEnvironments = plaidModule.PlaidEnvironments;

var plaidClient = new PlaidApi(
  new Configuration({
    basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
        'PLAID-SECRET': process.env.PLAID_SECRET
      }
    }
  })
);

var supabaseAdmin = supabaseModule.createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

var anthropic = new anthropicModule.default({ apiKey: process.env.ANTHROPIC_API_KEY });

// IRS rules (shortened for brevity - same as sync-transactions.js)
var IRS_RULES_SHORT = `
Categorize transactions as tax deductible or personal using IRS rules.
- Software, office supplies, business travel, advertising = 100% deductible (Pub 535)
- Meals at restaurants = 50% deductible (Pub 463 Sec 274(k))
- Vehicle/gas = business use percentage only (Pub 463 Sec 274(d))
- Equipment = 100% Section 179 (Pub 946)
- Personal items, groceries, entertainment = NOT deductible
Flag ambiguous items as needs_review.
`;

async function categorizeNewTransactions(transactions, userProfile) {
  if (transactions.length === 0) return [];

  var txList = transactions.map(function(t) {
    return {
      name: t.name,
      amount: t.amount,
      merchant: t.merchant_name || t.name,
      date: t.date
    };
  });

  var prompt = 'You are WealthRx tax categorization AI.\n\n' +
    'User business: ' + (userProfile.business_type || 'unknown') + ', ' +
    (userProfile.entity_type || 'LLC') + ', vehicle use: ' + (userProfile.vehicle_business_pct || 0) + '%\n\n' +
    IRS_RULES_SHORT + '\n\n' +
    'Return JSON array with: vendor, category, is_deductible, deduction_percent, needs_review, irs_reference, irs_link, irs_explanation, note.\n\n' +
    'Categories: Office Supplies, Software, Meals, Vehicle & Travel, Equipment, Professional Services, Internet & Phone, Advertising, Insurance, Education, Rent & Utilities, Bank Fees, Shipping, Contractor Payments, Personal, Income, Transfer\n\n' +
    'JSON only, no markdown.\n\n' +
    'Transactions: ' + JSON.stringify(txList, null, 2);

  var response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }]
  });

  try {
    var text = response.content[0].text;
    var cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(cleaned);
  } catch (e) {
    console.error('Parse error:', e);
    return [];
  }
}

async function sendPushNotification(userId, title, body, url) {
  // Get user's push subscription
  var subResult = await supabaseAdmin
    .from('push_subscriptions')
    .select('endpoint, keys_p256dh, keys_auth')
    .eq('user_id', userId);

  if (!subResult.data || subResult.data.length === 0) return;

  // For now, log that we would send a notification
  // In production, use web-push library to actually send
  console.log('Would send push notification to user ' + userId + ': ' + title);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    var webhook = req.body;
    console.log('Plaid webhook received:', webhook.webhook_type, webhook.webhook_code);

    // Only process transaction webhooks
    if (webhook.webhook_type !== 'TRANSACTIONS') {
      return res.status(200).json({ received: true });
    }

    var item_id = webhook.item_id;

    // Look up user from item_id
    var connResult = await supabaseAdmin
      .from('bank_connections')
      .select('user_id, access_token, institution_name')
      .eq('item_id', item_id)
      .single();

    if (connResult.error || !connResult.data) {
      console.error('No bank connection for item:', item_id);
      return res.status(200).json({ received: true });
    }

    var connection = connResult.data;
    var user_id = connection.user_id;

    // Get user profile for AI context
    var profileResult = await supabaseAdmin
      .from('profiles')
      .select('business_type, entity_type, uses_vehicle, vehicle_business_pct, account_type')
      .eq('id', user_id)
      .single();
    var userProfile = profileResult.data || {};

    // Handle different webhook types
    if (webhook.webhook_code === 'INITIAL_UPDATE' || webhook.webhook_code === 'HISTORICAL_UPDATE' || webhook.webhook_code === 'DEFAULT_UPDATE') {
      // New transactions available - sync them
      var now = new Date();
      var sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      var plaidResp = await plaidClient.transactionsGet({
        access_token: connection.access_token,
        start_date: sevenDaysAgo.toISOString().split('T')[0],
        end_date: now.toISOString().split('T')[0],
        options: { count: 50, offset: 0 }
      });

      var newTransactions = plaidResp.data.transactions;

      // Get existing transaction IDs to find truly new ones
      var existingResult = await supabaseAdmin
        .from('transactions')
        .select('plaid_transaction_id')
        .eq('user_id', user_id);

      var existingIds = (existingResult.data || []).map(function(t) { return t.plaid_transaction_id; });
      var trulyNew = newTransactions.filter(function(t) { return existingIds.indexOf(t.transaction_id) === -1; });

      if (trulyNew.length > 0) {
        // Categorize new ones with AI
        var categorized = await categorizeNewTransactions(trulyNew, userProfile);

        // Store in database
        var toStore = trulyNew.map(function(plaidTx, index) {
          var aiData = categorized[index] || {};
          return {
            user_id: user_id,
            plaid_transaction_id: plaidTx.transaction_id,
            name: plaidTx.name,
            vendor: aiData.vendor || plaidTx.merchant_name || plaidTx.name,
            amount: plaidTx.amount * -1,
            date: plaidTx.date,
            category: aiData.category || 'Uncategorized',
            is_deductible: aiData.is_deductible || false,
            deduction_percent: aiData.deduction_percent || 0,
            needs_review: aiData.needs_review || false,
            note: aiData.note || '',
            irs_reference: aiData.irs_reference || '',
            irs_link: aiData.irs_link || '',
            irs_explanation: aiData.irs_explanation || '',
            raw_category: plaidTx.personal_finance_category ? plaidTx.personal_finance_category.primary : ''
          };
        });

        await supabaseAdmin.from('transactions').upsert(toStore, { onConflict: 'plaid_transaction_id' });

        // Send push notification for large or notable transactions
        var largeTransactions = toStore.filter(function(t) { return Math.abs(t.amount) >= 100; });
        if (largeTransactions.length > 0) {
          var tx = largeTransactions[0];
          var title = '$' + Math.abs(tx.amount).toFixed(2) + ' at ' + tx.vendor;
          var body = tx.is_deductible ? '✅ ' + tx.deduction_percent + '% deductible — ' + tx.category : '❌ Not deductible — ' + tx.category;
          await sendPushNotification(user_id, title, body, 'https://app.wealthrx.ai/dashboard.html');
        } else if (toStore.length > 0) {
          // Batch notification for smaller transactions
          var deductibleCount = toStore.filter(function(t) { return t.is_deductible; }).length;
          var title = toStore.length + ' new transaction' + (toStore.length > 1 ? 's' : '');
          var body = deductibleCount + ' deductible, ' + (toStore.length - deductibleCount) + ' personal';
          await sendPushNotification(user_id, title, body, 'https://app.wealthrx.ai/dashboard.html');
        }
      }

      // Update last_synced timestamp
      await supabaseAdmin
        .from('bank_connections')
        .update({ last_synced: new Date().toISOString() })
        .eq('item_id', item_id);
    }

    res.status(200).json({ received: true });
  } catch (error) {
    console.error('Webhook error:', error.message);
    res.status(200).json({ received: true, error: error.message });
  }
};

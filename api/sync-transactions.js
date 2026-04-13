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

var IRS_RULES = `
IRS DEDUCTION RULES FOR SMALL BUSINESSES:

FULLY DEDUCTIBLE (100%):
- Office supplies and materials (Pub 535, Sec 162): Paper, pens, printer ink, desk accessories, cleaning supplies for office
- Software and SaaS subscriptions (Pub 535, Sec 162): Adobe, Microsoft, Google Workspace, Slack, Zoom, QuickBooks, any business software
- Business insurance premiums (Pub 535, Sec 162): Liability, professional, property insurance for business
- Professional services (Pub 535, Sec 162): Legal fees, accounting fees, consulting, bookkeeping
- Advertising and marketing (Pub 535, Sec 162): Google Ads, Facebook Ads, business cards, website hosting, domain names, social media tools
- Business phone and internet (Pub 535, Sec 162): Business phone line, internet service used for business (prorate if mixed use)
- Rent for business space (Pub 535, Sec 162): Office rent, storage units, co-working space memberships
- Equipment and tools (Pub 946, Sec 179): Computers, printers, cameras, tools, machinery — can fully deduct in year of purchase under Section 179
- Business travel (Pub 463, Ch 1, Sec 162(a)(2)): Flights, hotels, car rentals, parking, tolls — must be primarily for business
- Business education (Pub 970, Sec 162): Courses, certifications, books, conferences that improve current business skills
- Bank fees and merchant processing (Pub 535, Sec 162): Monthly fees, transaction fees, wire transfer fees, Stripe/PayPal fees
- Shipping and postage (Pub 535, Sec 162): USPS, UPS, FedEx for business shipments
- Business licenses and permits (Pub 535, Sec 162): State, local, federal licenses and registration fees
- Contractor payments (Pub 535, Sec 162): Payments to independent contractors for business services

PARTIALLY DEDUCTIBLE:
- Business meals (Pub 463, Ch 2, Sec 274(k)): 50% deductible ONLY if directly related to business discussion. Must document who attended and business purpose. Fast food, restaurants, coffee meetings all qualify IF business-related.
- Vehicle expenses (Pub 463, Ch 4, Sec 274(d)): Only the BUSINESS USE PERCENTAGE is deductible. Gas, maintenance, insurance, parking for business trips. Commuting to regular workplace is NEVER deductible.
- Home office (Pub 587, Sec 280A): Percentage of home used exclusively for business. Simplified method: $5 per sq ft, max 300 sq ft ($1,500 max).
- Cell phone (Pub 535, Sec 162): Business use percentage only. If 70% business use, 70% of bill is deductible.

NEVER DEDUCTIBLE:
- Personal groceries and household items
- Personal clothing (unless uniforms or required safety gear)
- Gym memberships (unless fitness IS the business)
- Entertainment and recreation (post-2018 Tax Cuts and Jobs Act)
- Personal rent or mortgage payments
- Personal insurance (health, auto, home — unless business policy)
- Gifts over $25 per recipient per year (Pub 463, Sec 274(b))
- Political contributions
- Commuting from home to regular workplace
- Personal care (haircuts, cosmetics — unless entertainment/media business)
- Fines and penalties
- Personal subscriptions (Netflix, Spotify — unless content creation business)
- Personal travel and vacations

IMPORTANT NUANCES:
- Amazon purchases could be business OR personal — ALWAYS flag as NEEDS REVIEW unless clearly an office/business item
- Walmart, Target, Costco — could be business supplies OR personal groceries — NEEDS REVIEW
- Gas stations — apply vehicle business use percentage if user drives for business, otherwise personal
- Restaurants — default to 50% deductible with NEEDS REVIEW flag so user can confirm business purpose
- Uber/Lyft — could be business travel or personal — NEEDS REVIEW
- Subscriptions — determine if business tool or personal entertainment
`;

async function getUserProfile(userId) {
  var result = await supabaseAdmin
    .from('profiles')
    .select('business_type, entity_type, work_location, uses_vehicle, vehicle_business_pct, account_type')
    .eq('id', userId)
    .single();
  return result.data || {};
}

async function categorizeTransactions(transactions, userProfile) {
  var txList = transactions.map(function(t) {
    return {
      name: t.name,
      amount: t.amount,
      plaid_category: t.personal_finance_category ? t.personal_finance_category.primary : (t.category ? t.category[0] : 'UNKNOWN'),
      merchant: t.merchant_name || t.name,
      date: t.date
    };
  });

  var businessContext = 'BUSINESS CONTEXT:\n';
  businessContext += '- Business type: ' + (userProfile.business_type || 'unknown') + '\n';
  businessContext += '- Entity type: ' + (userProfile.entity_type || 'unknown') + '\n';
  businessContext += '- Work location: ' + (userProfile.work_location || 'unknown') + '\n';
  businessContext += '- Uses vehicle for business: ' + (userProfile.uses_vehicle ? 'Yes, ' + (userProfile.vehicle_business_pct || 0) + '% business use' : 'No') + '\n';
  businessContext += '- Account type: ' + (userProfile.account_type || 'unknown') + '\n';

  var prompt = 'You are WealthRx, an AI tax categorization engine for small businesses. Analyze these bank transactions and categorize each one for tax deduction purposes.\n\n' +
    businessContext + '\n' +
    IRS_RULES + '\n\n' +
    'For EACH transaction, return a JSON array with objects containing:\n' +
    '- "name": the original transaction name\n' +
    '- "vendor": clean vendor name (e.g., "AMZN Mktp US*2K4" becomes "Amazon")\n' +
    '- "category": one of these EXACT categories: "Office Supplies", "Software", "Meals", "Vehicle & Travel", "Equipment", "Professional Services", "Internet & Phone", "Advertising", "Insurance", "Education", "Rent & Utilities", "Bank Fees", "Shipping", "Contractor Payments", "Personal", "Income", "Transfer"\n' +
    '- "is_deductible": true ONLY if clearly a business expense. false for personal. false for ambiguous items that need review.\n' +
    '- "deduction_percent": 100 for fully deductible business expenses, 50 for meals (business meals only), ' + (userProfile.vehicle_business_pct || 0) + ' for vehicle/gas expenses, 0 for personal items, 0 for items needing review\n' +
    '- "needs_review": true if the transaction is ambiguous and the user should confirm whether it is business or personal. Examples: Amazon, Walmart, restaurants, Uber, gas stations\n' +
    '- "irs_reference": the IRS publication and section number (e.g., "Pub 535, Sec 162" or "Pub 463, Sec 274(k)")\n' +
    '- "irs_link": the IRS.gov URL for the relevant publication (e.g., "https://www.irs.gov/publications/p535")\n' +
    '- "irs_explanation": a plain-English explanation (15-20 words) of WHY this is or is not deductible, referencing the IRS rule\n' +
    '- "note": a brief 5-10 word summary of the categorization decision\n\n' +
    'CRITICAL RULES:\n' +
    '1. When in doubt, set needs_review to true and is_deductible to false. It is BETTER to ask the user than to incorrectly claim a deduction.\n' +
    '2. Meals at restaurants are ALWAYS 50% deductible maximum, never 100%.\n' +
    '3. If the account is "mixed" personal and business, be MORE conservative — flag more items as needs_review.\n' +
    '4. If the account is "business_only", be more confident in marking business expenses as deductible.\n' +
    '5. Gas/fuel transactions use the vehicle business percentage: ' + (userProfile.vehicle_business_pct || 0) + '%\n' +
    '6. NEVER mark entertainment, personal groceries, or personal subscriptions as deductible.\n\n' +
    'Respond with ONLY the JSON array, no other text, no markdown formatting.\n\n' +
    'Transactions:\n' + JSON.stringify(txList, null, 2);

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
    console.error('Failed to parse Claude response:', e);
    console.error('Raw response:', response.content[0].text);
    return [];
  }
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    var user_id = req.body.user_id;

    // Get user profile for business context
    var userProfile = await getUserProfile(user_id);

    // Get access token from Supabase
    var connResult = await supabaseAdmin
      .from('bank_connections')
      .select('access_token')
      .eq('user_id', user_id)
      .single();

    if (connResult.error || !connResult.data) {
      return res.status(400).json({ error: 'No bank connection found' });
    }

    // Get transactions from Plaid (last 30 days)
    var now = new Date();
    var thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    var plaidResponse = await plaidClient.transactionsGet({
      access_token: connResult.data.access_token,
      start_date: thirtyDaysAgo.toISOString().split('T')[0],
      end_date: now.toISOString().split('T')[0],
      options: { count: 100, offset: 0 }
    });

    var plaidTransactions = plaidResponse.data.transactions;

    if (plaidTransactions.length === 0) {
      return res.json({ success: true, count: 0 });
    }

    // Categorize with Claude AI (batch in groups of 20)
    var batchSize = 20;
    var allCategorized = [];

    for (var i = 0; i < plaidTransactions.length; i += batchSize) {
      var batch = plaidTransactions.slice(i, i + batchSize);
      var categorized = await categorizeTransactions(batch, userProfile);
      allCategorized = allCategorized.concat(categorized);
    }

    // Match categorized data back to original transactions and store
    var toStore = plaidTransactions.map(function(plaidTx, index) {
      var aiData = allCategorized[index] || {};

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

    // Upsert to Supabase
    var insertResult = await supabaseAdmin
      .from('transactions')
      .upsert(toStore, { onConflict: 'plaid_transaction_id' });

    if (insertResult.error) throw insertResult.error;

    // Update account balance
    var accounts = plaidResponse.data.accounts;
    if (accounts && accounts.length > 0) {
      var totalBalance = accounts.reduce(function(sum, a) { return sum + (a.balances.current || 0); }, 0);
      await supabaseAdmin
        .from('bank_connections')
        .update({ balance: totalBalance, last_synced: new Date().toISOString() })
        .eq('user_id', user_id);
    }

    res.json({ success: true, count: toStore.length });
  } catch (error) {
    console.error('Sync error:', error.response ? error.response.data : error.message || error);
    res.status(500).json({ error: 'Failed to sync transactions' });
  }
};

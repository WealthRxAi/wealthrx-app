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
- Office supplies and materials (Pub 535, Sec 162)
- Software and SaaS subscriptions (Pub 535, Sec 162): Adobe, Microsoft, Google Workspace, Slack, Zoom, QuickBooks
- Business insurance premiums (Pub 535, Sec 162)
- Professional services (Pub 535, Sec 162): Legal, accounting, consulting, bookkeeping
- Advertising and marketing (Pub 535, Sec 162): Google Ads, Facebook Ads, business cards, website hosting
- Business phone and internet (Pub 535, Sec 162): prorate if mixed use
- Rent for business space (Pub 535, Sec 162): Office rent, storage units, co-working
- Equipment and tools (Pub 946, Sec 179): Computers, printers, cameras, tools, machinery — fully deduct in year of purchase under Section 179
- Business travel (Pub 463, Ch 1, Sec 162(a)(2)): Flights, hotels, car rentals, parking
- Business education (Pub 970, Sec 162): Courses, certifications, books, conferences
- Bank fees and merchant processing (Pub 535, Sec 162)
- Shipping and postage (Pub 535, Sec 162)
- Business licenses and permits (Pub 535, Sec 162)
- Contractor payments (Pub 535, Sec 162)

PARTIALLY DEDUCTIBLE:
- Business meals (Pub 463, Ch 2, Sec 274(k)): 50% deductible ONLY if directly related to business discussion
- Vehicle expenses (Pub 463, Ch 4, Sec 274(d)): Only BUSINESS USE PERCENTAGE is deductible. Commuting NEVER deductible.
- Home office (Pub 587, Sec 280A): Simplified method: $5 per sq ft, max 300 sq ft ($1,500 max)
- Cell phone (Pub 535, Sec 162): Business use percentage only

NEVER DEDUCTIBLE:
- Personal groceries and household items
- Personal clothing (unless uniforms)
- Gym memberships (unless fitness IS the business)
- Entertainment and recreation (post-2018)
- Personal rent or mortgage
- Personal insurance
- Gifts over $25 per recipient per year
- Political contributions
- Commuting from home to regular workplace
- Personal care
- Fines and penalties
- Personal subscriptions

IMPORTANT NUANCES:
- Amazon purchases — flag as NEEDS REVIEW unless clearly office/business
- Walmart, Target, Costco — NEEDS REVIEW
- Gas stations — apply vehicle business use percentage
- Restaurants — default 50% with NEEDS REVIEW
- Uber/Lyft — NEEDS REVIEW
- Subscriptions — determine if business tool or personal
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

  var prompt = 'You are WealthRx, an AI tax categorization engine for small businesses. Analyze these bank transactions.\n\n' +
    businessContext + '\n' +
    IRS_RULES + '\n\n' +
    'For EACH transaction, return a JSON array with objects containing:\n' +
    '- "name": the original transaction name\n' +
    '- "vendor": clean vendor name\n' +
    '- "category": EXACT categories: "Office Supplies", "Software", "Meals", "Vehicle & Travel", "Equipment", "Professional Services", "Internet & Phone", "Advertising", "Insurance", "Education", "Rent & Utilities", "Bank Fees", "Shipping", "Contractor Payments", "Personal", "Income", "Transfer"\n' +
    '- "is_deductible": true if likely business, false only for clearly personal\n' +
    '- "deduction_percent": 100 for fully deductible, 50 for meals, ' + (userProfile.vehicle_business_pct || 0) + ' for vehicle/gas/Uber/Lyft, 0 for personal\n' +
    '- "needs_review": true if ambiguous\n' +
    '- "irs_reference": IRS publication (e.g., "Pub 535, Sec 162")\n' +
    '- "irs_link": IRS.gov URL\n' +
    '- "irs_explanation": 15-20 word explanation\n' +
    '- "note": 5-10 word summary\n\n' +
    'Respond with ONLY the JSON array, no markdown.\n\n' +
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
    return [];
  }
}

// Fetch ALL transactions from a single Plaid item, paginated
async function fetchAllPlaidTransactions(accessToken, startDate, endDate) {
  var allTransactions = [];
  var allAccounts = [];
  var offset = 0;
  var pageSize = 500; // Plaid max per call
  var totalAvailable = null;
  var maxIterations = 20; // safety limit (10,000 transactions max)
  var iteration = 0;

  while (iteration < maxIterations) {
    var resp = await plaidClient.transactionsGet({
      access_token: accessToken,
      start_date: startDate,
      end_date: endDate,
      options: { count: pageSize, offset: offset }
    });

    if (offset === 0) {
      totalAvailable = resp.data.total_transactions;
      allAccounts = resp.data.accounts || [];
    }

    allTransactions = allTransactions.concat(resp.data.transactions);

    if (allTransactions.length >= totalAvailable || resp.data.transactions.length === 0) {
      break;
    }

    offset += pageSize;
    iteration += 1;
  }

  return { transactions: allTransactions, accounts: allAccounts };
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    var user_id = req.body.user_id;
    var userProfile = await getUserProfile(user_id);

    // Get ALL bank connections for this user
    var connResult = await supabaseAdmin
      .from('bank_connections')
      .select('access_token, institution_name, item_id')
      .eq('user_id', user_id);

    if (connResult.error || !connResult.data || connResult.data.length === 0) {
      return res.status(400).json({ error: 'No bank connection found' });
    }

    // FIXED: Pull 24 months of history (Plaid's max), not 30 days
    var now = new Date();
    var twoYearsAgo = new Date(now.getTime() - 730 * 24 * 60 * 60 * 1000); // 730 days = ~24 months

    var allPlaidTransactions = [];
    var allAccounts = [];
    var institutionMap = {};
    var bankResults = [];

    for (var c = 0; c < connResult.data.length; c++) {
      var connection = connResult.data[c];
      try {
        // Fetch ALL transactions paginated
        var result = await fetchAllPlaidTransactions(
          connection.access_token,
          twoYearsAgo.toISOString().split('T')[0],
          now.toISOString().split('T')[0]
        );

        // Tag each transaction with its institution
        result.transactions.forEach(function(tx) {
          institutionMap[tx.transaction_id] = connection.institution_name;
        });

        allPlaidTransactions = allPlaidTransactions.concat(result.transactions);
        allAccounts = allAccounts.concat(result.accounts);

        bankResults.push({
          institution: connection.institution_name,
          transactions_pulled: result.transactions.length
        });

        // Update last_synced for this connection
        await supabaseAdmin
          .from('bank_connections')
          .update({
            last_synced: new Date().toISOString(),
            balance: result.accounts.reduce(function(s, a) { return s + (a.balances.current || 0); }, 0)
          })
          .eq('item_id', connection.item_id);
      } catch (plaidErr) {
        console.error('Plaid error for ' + connection.institution_name + ':', plaidErr.message);
        bankResults.push({
          institution: connection.institution_name,
          error: plaidErr.message
        });
      }
    }

    if (allPlaidTransactions.length === 0) {
      return res.json({ success: true, count: 0, message: 'No transactions found across all connected banks' });
    }

    // Categorize in batches of 20 to keep Claude API responsive
    var batchSize = 20;
    var allCategorized = [];

    for (var i = 0; i < allPlaidTransactions.length; i += batchSize) {
      var batch = allPlaidTransactions.slice(i, i + batchSize);
      var categorized = await categorizeTransactions(batch, userProfile);
      allCategorized = allCategorized.concat(categorized);
    }

    // Map back and store
    var toStore = allPlaidTransactions.map(function(plaidTx, index) {
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

    // Insert in chunks to avoid Supabase timeouts on large batches
    var insertChunkSize = 200;
    for (var j = 0; j < toStore.length; j += insertChunkSize) {
      var chunk = toStore.slice(j, j + insertChunkSize);
      var insertResult = await supabaseAdmin
        .from('transactions')
        .upsert(chunk, { onConflict: 'plaid_transaction_id' });

      if (insertResult.error) {
        console.error('Insert chunk error:', insertResult.error);
        throw insertResult.error;
      }
    }

    res.json({
      success: true,
      count: toStore.length,
      banks_synced: connResult.data.length,
      banks: bankResults,
      date_range: {
        start: twoYearsAgo.toISOString().split('T')[0],
        end: now.toISOString().split('T')[0]
      }
    });
  } catch (error) {
    console.error('Sync error:', error.response ? error.response.data : error.message || error);
    res.status(500).json({ error: 'Failed to sync transactions', details: error.message });
  }
};

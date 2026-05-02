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

CRITICAL RULES (apply BEFORE deduction logic):
1. POSITIVE AMOUNTS = INCOME = NEVER DEDUCTIBLE
2. TRANSFERS BETWEEN ACCOUNTS = NEEDS REVIEW (could be intercompany, capital contribution, ATM deposits, etc.)
3. ATM deposits/withdrawals = NEEDS REVIEW (source unknown)

FULLY DEDUCTIBLE EXPENSES (100%):
- Office supplies and materials (Pub 535, Sec 162)
- Software and SaaS subscriptions (Pub 535, Sec 162)
- Business insurance premiums (Pub 535, Sec 162)
- Professional services (Pub 535, Sec 162)
- Advertising and marketing (Pub 535, Sec 162)
- Business phone and internet (Pub 535, Sec 162)
- Rent for business space (Pub 535, Sec 162)
- Equipment (Pub 946, Sec 179) - up to limit, fully deductible in year of purchase
- Business travel (Pub 463, Ch 1)
- Business education (Pub 970, Sec 162)
- Bank fees and merchant processing (Pub 535, Sec 162)
- Shipping and postage (Pub 535, Sec 162)
- Business licenses and permits (Pub 535, Sec 162)
- Contractor payments (Pub 535, Sec 162)

PARTIALLY DEDUCTIBLE EXPENSES:
- Business meals (Pub 463, Sec 274(k)): 50% deductible
- Vehicle expenses (Pub 463, Sec 274(d)): Business use percentage only
- Home office (Pub 587, Sec 280A): Simplified $5/sq ft up to $1,500
- Cell phone (Pub 535, Sec 162): Business use percentage

NEVER DEDUCTIBLE:
- Personal expenses, groceries, clothing, gym
- Entertainment (post-2018)
- Personal rent or mortgage
- Commuting from home to regular workplace
- Fines and penalties

INCOME (POSITIVE AMOUNTS):
- eBay/Amazon/Stripe sales = INCOME
- Customer payments (ACH/wire) = INCOME
- Refunds received = reduce previous expense, not new income
- Interest earned = INCOME

TRANSFERS (FLAG FOR REVIEW):
- ACH transfers between accounts = REVIEW (could be intercompany or self-transfer)
- ATM deposits = REVIEW (cash source unknown)
- ATM withdrawals = REVIEW (use unknown)
- Wire transfers between owned entities = REVIEW (intercompany)
- Zelle to/from family = REVIEW (could be loan, gift, or business)
- Internal bank transfers = NOT income, NOT deduction, just movement
- Rent paid TO own LLC = REVIEW (deductible to payor, income to recipient)
- Loan disbursements/repayments = REVIEW (principal vs interest)

REVIEW NUANCES:
- Amazon, Walmart, Target, Costco — REVIEW
- Restaurants — default 50% with REVIEW
- Uber/Lyft — REVIEW
- Subscriptions — determine if business or personal
`;

// Detect if a transaction is a transfer/ATM/inter-account movement
// Returns true if this needs review regardless of AI judgment
function isTransferOrAmbiguous(plaidTx) {
  var name = (plaidTx.name || '').toUpperCase();
  var merchant = (plaidTx.merchant_name || '').toUpperCase();
  var combined = name + ' ' + merchant;

  // Plaid's own transfer category
  if (plaidTx.personal_finance_category && plaidTx.personal_finance_category.primary === 'TRANSFER_IN') return true;
  if (plaidTx.personal_finance_category && plaidTx.personal_finance_category.primary === 'TRANSFER_OUT') return true;

  // Common transfer/ATM keywords
  var transferKeywords = [
    'TRANSFER', 'XFER', 'XFR',
    'ATM', 'CASH WITHDRAWAL', 'CASH DEPOSIT',
    'ZELLE', 'VENMO', 'CASHAPP', 'CASH APP',
    'WIRE', 'ACH',
    'MOBILE DEPOSIT', 'CHECK DEPOSIT',
    'INTERNAL TRANSFER',
    'BETWEEN ACCOUNTS',
    'P2P', 'PERSON TO PERSON',
    'BANK CREDIT', 'BANK DEBIT',
    'DEPOSIT MADE', 'WITHDRAWAL'
  ];

  for (var i = 0; i < transferKeywords.length; i++) {
    if (combined.indexOf(transferKeywords[i]) !== -1) {
      return true;
    }
  }

  return false;
}

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
    'PLAID AMOUNT CONVENTION:\n' +
    '- POSITIVE amount = expense (money LEAVING)\n' +
    '- NEGATIVE amount = income (money COMING IN)\n\n' +
    businessContext + '\n' +
    IRS_RULES + '\n\n' +
    'For EACH transaction, return JSON with:\n' +
    '- "name": original name\n' +
    '- "vendor": clean vendor name\n' +
    '- "category": one of: "Office Supplies", "Software", "Meals", "Vehicle & Travel", "Equipment", "Professional Services", "Internet & Phone", "Advertising", "Insurance", "Education", "Rent & Utilities", "Bank Fees", "Shipping", "Contractor Payments", "Personal", "Income", "Transfer"\n' +
    '- "is_deductible": true ONLY if business expense AND positive Plaid amount. False for income, transfers.\n' +
    '- "deduction_percent": 100 for fully deductible, 50 for meals, ' + (userProfile.vehicle_business_pct || 0) + ' for vehicle/Uber/Lyft, 0 for personal/income/transfers\n' +
    '- "needs_review": true if ambiguous, transfer-like, ATM, or cross-account\n' +
    '- "irs_reference": IRS pub or "N/A" for income/transfers\n' +
    '- "irs_link": IRS URL or "N/A"\n' +
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

async function fetchAllPlaidTransactions(accessToken, startDate, endDate) {
  var allTransactions = [];
  var allAccounts = [];
  var offset = 0;
  var pageSize = 500;
  var totalAvailable = null;
  var maxIterations = 20;
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

    var connResult = await supabaseAdmin
      .from('bank_connections')
      .select('access_token, institution_name, item_id')
      .eq('user_id', user_id);

    if (connResult.error || !connResult.data || connResult.data.length === 0) {
      return res.status(400).json({ error: 'No bank connection found' });
    }

    var now = new Date();
    var twoYearsAgo = new Date(now.getTime() - 730 * 24 * 60 * 60 * 1000);

    var allPlaidTransactions = [];
    var allAccounts = [];
    var bankResults = [];

    for (var c = 0; c < connResult.data.length; c++) {
      var connection = connResult.data[c];
      try {
        var result = await fetchAllPlaidTransactions(
          connection.access_token,
          twoYearsAgo.toISOString().split('T')[0],
          now.toISOString().split('T')[0]
        );

        allPlaidTransactions = allPlaidTransactions.concat(result.transactions);
        allAccounts = allAccounts.concat(result.accounts);

        bankResults.push({
          institution: connection.institution_name,
          transactions_pulled: result.transactions.length
        });

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

    var batchSize = 20;
    var allCategorized = [];

    for (var i = 0; i < allPlaidTransactions.length; i += batchSize) {
      var batch = allPlaidTransactions.slice(i, i + batchSize);
      var categorized = await categorizeTransactions(batch, userProfile);
      allCategorized = allCategorized.concat(categorized);
    }

    // Map back and store with TRIPLE PROTECTION:
    // 1. Income transactions (positive stored amount) → never deductible
    // 2. Transfer/ATM transactions → always need review, not deductible
    // 3. Trust AI for normal expenses
    var toStore = allPlaidTransactions.map(function(plaidTx, index) {
      var aiData = allCategorized[index] || {};
      var storedAmount = plaidTx.amount * -1;
      var isIncome = storedAmount > 0;
      var isTransferLike = isTransferOrAmbiguous(plaidTx);

      var isDeductible, deductionPercent, category, needsReview, irsReference, irsLink, irsExplanation;

      if (isTransferLike) {
        // TRANSFER OR ATM - flag for review, don't auto-categorize
        isDeductible = false;
        deductionPercent = 0;
        category = 'Transfer';
        needsReview = true;
        irsReference = 'N/A';
        irsLink = 'N/A';
        irsExplanation = isIncome
          ? 'Transfer/deposit detected. Verify source: customer payment, intercompany transfer, or capital contribution?'
          : 'Transfer/withdrawal detected. Verify purpose: intercompany payment, owner draw, or business expense?';
      } else if (isIncome) {
        // INCOME - hardcoded non-deductible
        isDeductible = false;
        deductionPercent = 0;
        category = 'Income';
        needsReview = false;
        irsReference = 'N/A';
        irsLink = 'N/A';
        irsExplanation = 'Income received - not a deductible expense';
      } else {
        // EXPENSE - trust AI
        isDeductible = aiData.is_deductible || false;
        deductionPercent = aiData.deduction_percent || 0;
        category = aiData.category || 'Uncategorized';
        needsReview = aiData.needs_review || false;
        irsReference = aiData.irs_reference || '';
        irsLink = aiData.irs_link || '';
        irsExplanation = aiData.irs_explanation || '';
      }

      return {
        user_id: user_id,
        plaid_transaction_id: plaidTx.transaction_id,
        name: plaidTx.name,
        vendor: aiData.vendor || plaidTx.merchant_name || plaidTx.name,
        amount: storedAmount,
        date: plaidTx.date,
        category: category,
        is_deductible: isDeductible,
        deduction_percent: deductionPercent,
        needs_review: needsReview,
        note: aiData.note || '',
        irs_reference: irsReference,
        irs_link: irsLink,
        irs_explanation: irsExplanation,
        raw_category: plaidTx.personal_finance_category ? plaidTx.personal_finance_category.primary : ''
      };
    });

    // Insert in chunks to avoid timeout
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

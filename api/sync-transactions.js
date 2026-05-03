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
2. TRANSFERS BETWEEN ACCOUNTS = NEEDS REVIEW
3. ATM deposits/withdrawals = NEEDS REVIEW

FULLY DEDUCTIBLE EXPENSES (100%):
- Office supplies (Pub 535, Sec 162)
- Software/SaaS (Pub 535, Sec 162)
- Insurance (Pub 535, Sec 162)
- Professional services (Pub 535, Sec 162)
- Advertising (Pub 535, Sec 162)
- Phone/internet (Pub 535, Sec 162)
- Rent (Pub 535, Sec 162)
- Equipment under Section 179 (Pub 946)
- Business travel (Pub 463, Ch 1)
- Education (Pub 970, Sec 162)
- Bank fees (Pub 535, Sec 162)
- Shipping (Pub 535, Sec 162)
- Licenses (Pub 535, Sec 162)
- Contractor payments (Pub 535, Sec 162)

PARTIALLY DEDUCTIBLE:
- Business meals 50% (Pub 463, Sec 274(k))
- Vehicle business use % (Pub 463, Sec 274(d))
- Home office $5/sq ft up to $1,500 (Pub 587, Sec 280A)
- Cell phone business % (Pub 535)

NEVER DEDUCTIBLE:
- Personal expenses, groceries, clothing
- Entertainment (post-2018)
- Personal mortgage/rent
- Commuting
- Fines

INCOME (POSITIVE AMOUNTS):
- eBay, Amazon, Stripe sales = INCOME
- Customer ACH = INCOME  
- Refunds reduce expense, not income
- Interest = INCOME

TRANSFERS (FLAG FOR REVIEW):
- ACH transfers = REVIEW
- ATM activity = REVIEW
- Wire transfers = REVIEW
- Zelle/Venmo = REVIEW
- Internal transfers = NOT income/deduction
`;

// Detect transfer-like transactions
function isTransferOrAmbiguous(plaidTx) {
  var name = (plaidTx.name || '').toUpperCase();
  var merchant = (plaidTx.merchant_name || '').toUpperCase();
  var combined = name + ' ' + merchant;

  if (plaidTx.personal_finance_category && plaidTx.personal_finance_category.primary === 'TRANSFER_IN') return true;
  if (plaidTx.personal_finance_category && plaidTx.personal_finance_category.primary === 'TRANSFER_OUT') return true;

  var transferKeywords = [
    'TRANSFER', 'XFER', 'XFR',
    'ATM', 'CASH WITHDRAWAL', 'CASH DEPOSIT',
    'ZELLE', 'VENMO', 'CASHAPP', 'CASH APP',
    'WIRE', 'MOBILE DEPOSIT', 'CHECK DEPOSIT',
    'INTERNAL TRANSFER', 'BETWEEN ACCOUNTS',
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

// Generate a stable hash for deduplication
// This handles Plaid's habit of changing transaction IDs
function generateDedupeKey(tx) {
  var vendor = (tx.merchant_name || tx.name || '').toUpperCase().trim();
  var amount = parseFloat(tx.amount).toFixed(2);
  var date = tx.date;
  return vendor + '|' + amount + '|' + date;
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

  var prompt = 'You are WealthRx, an AI tax categorization engine. Analyze these bank transactions.\n\n' +
    'PLAID AMOUNT CONVENTION:\n' +
    '- POSITIVE = expense\n' +
    '- NEGATIVE = income\n\n' +
    businessContext + '\n' +
    IRS_RULES + '\n\n' +
    'For EACH transaction, return JSON with:\n' +
    '- "name", "vendor"\n' +
    '- "category": one of "Office Supplies","Software","Meals","Vehicle & Travel","Equipment","Professional Services","Internet & Phone","Advertising","Insurance","Education","Rent & Utilities","Bank Fees","Shipping","Contractor Payments","Personal","Income","Transfer"\n' +
    '- "is_deductible": boolean\n' +
    '- "deduction_percent": 100/50/' + (userProfile.vehicle_business_pct || 0) + '/0\n' +
    '- "needs_review": boolean\n' +
    '- "irs_reference", "irs_link", "irs_explanation", "note"\n\n' +
    'Respond with ONLY the JSON array.\n\n' +
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
      return res.json({ success: true, count: 0, message: 'No transactions found' });
    }

    // CRITICAL FIX: Dedupe BEFORE categorizing
    // This handles Plaid's habit of generating new IDs for same transaction
    // We dedupe by vendor + amount + date combination
    var seenKeys = {};
    var dedupedPlaidTransactions = [];
    for (var d = 0; d < allPlaidTransactions.length; d++) {
      var dedupeKey = generateDedupeKey(allPlaidTransactions[d]);
      if (!seenKeys[dedupeKey]) {
        seenKeys[dedupeKey] = true;
        dedupedPlaidTransactions.push(allPlaidTransactions[d]);
      }
    }

    // ALSO: Check existing DB to avoid creating duplicates of transactions already there
    var existingResult = await supabaseAdmin
      .from('transactions')
      .select('vendor, amount, date')
      .eq('user_id', user_id);

    var existingKeys = {};
    if (existingResult.data) {
      existingResult.data.forEach(function(existing) {
        var existingVendor = (existing.vendor || '').toUpperCase().trim();
        var existingAmount = parseFloat(Math.abs(existing.amount)).toFixed(2);
        // Note: stored amount is sign-flipped, so we compare absolute values
        var key = existingVendor + '|' + existingAmount + '|' + existing.date;
        existingKeys[key] = true;
      });
    }

    // Filter out transactions that already exist in DB
    var newTransactions = dedupedPlaidTransactions.filter(function(plaidTx) {
      var vendor = (plaidTx.merchant_name || plaidTx.name || '').toUpperCase().trim();
      var amount = parseFloat(Math.abs(plaidTx.amount)).toFixed(2);
      var key = vendor + '|' + amount + '|' + plaidTx.date;
      return !existingKeys[key];
    });

    if (newTransactions.length === 0) {
      return res.json({
        success: true,
        count: 0,
        skipped_existing: dedupedPlaidTransactions.length,
        message: 'All transactions already in database'
      });
    }

    // Categorize new transactions only
    var batchSize = 20;
    var allCategorized = [];

    for (var i = 0; i < newTransactions.length; i += batchSize) {
      var batch = newTransactions.slice(i, i + batchSize);
      var categorized = await categorizeTransactions(batch, userProfile);
      allCategorized = allCategorized.concat(categorized);
    }

    var toStore = newTransactions.map(function(plaidTx, index) {
      var aiData = allCategorized[index] || {};
      var storedAmount = plaidTx.amount * -1;
      var isIncome = storedAmount > 0;
      var isTransferLike = isTransferOrAmbiguous(plaidTx);

      var isDeductible, deductionPercent, category, needsReview;
      var irsReference, irsLink, irsExplanation;

      if (isTransferLike) {
        isDeductible = false;
        deductionPercent = 0;
        category = 'Transfer';
        needsReview = true;
        irsReference = 'N/A';
        irsLink = 'N/A';
        irsExplanation = isIncome
          ? 'Transfer/deposit detected. Verify source.'
          : 'Transfer/withdrawal detected. Verify purpose.';
      } else if (isIncome) {
        isDeductible = false;
        deductionPercent = 0;
        category = 'Income';
        needsReview = false;
        irsReference = 'N/A';
        irsLink = 'N/A';
        irsExplanation = 'Income received - not a deductible expense';
      } else {
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

    // Insert in chunks
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
      skipped_existing: dedupedPlaidTransactions.length - newTransactions.length,
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

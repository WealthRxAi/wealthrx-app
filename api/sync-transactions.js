const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

const plaidClient = new PlaidApi(
  new Configuration({
    basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
        'PLAID-SECRET': process.env.PLAID_SECRET,
      },
    },
  })
);

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function categorizeTransactions(transactions) {
  const txList = transactions.map(t => ({
    name: t.name,
    amount: t.amount,
    category: t.personal_finance_category?.primary || t.category?.[0] || 'UNKNOWN',
    merchant: t.merchant_name || t.name,
    date: t.date
  }));

  const prompt = `You are WealthRx, an AI CFO for small businesses. Analyze these business bank transactions and categorize each one for tax purposes.

For EACH transaction, return a JSON array with objects containing:
- "name": the original transaction name
- "vendor": clean vendor name (e.g., "AMZN Mktp US*2K4" becomes "Amazon")
- "category": one of these exact categories: "Office Supplies", "Software", "Meals", "Vehicle & Travel", "Equipment", "Professional Services", "Internet & Phone", "Advertising", "Insurance", "Education", "Rent & Utilities", "Bank Fees", "Personal", "Income", "Transfer"
- "is_deductible": true/false (is this a legitimate business tax deduction?)
- "deduction_percent": 100 for fully deductible, 50 for meals, 0 for personal. Use your best judgment.
- "needs_review": true if you're unsure and the user should confirm
- "note": a brief 5-10 word explanation of why it is or isn't deductible

Assume this is a small business owner. Be generous but accurate with deductions. If something could be business OR personal (like a restaurant), mark it as needs_review with 50% deduction.

Respond with ONLY the JSON array, no other text.

Transactions:
${JSON.stringify(txList, null, 2)}`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }]
  });

  try {
    const text = response.content[0].text;
    // Clean potential markdown formatting
    const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(cleaned);
  } catch (e) {
    console.error('Failed to parse Claude response:', e);
    return [];
  }
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { user_id } = req.body;

    // Get access token from Supabase
    const { data: connection, error: connError } = await supabaseAdmin
      .from('bank_connections')
      .select('access_token')
      .eq('user_id', user_id)
      .single();

    if (connError || !connection) {
      return res.status(400).json({ error: 'No bank connection found' });
    }

    // Get transactions from Plaid (last 30 days)
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const plaidResponse = await plaidClient.transactionsGet({
      access_token: connection.access_token,
      start_date: thirtyDaysAgo.toISOString().split('T')[0],
      end_date: now.toISOString().split('T')[0],
      options: { count: 100, offset: 0 }
    });

    const plaidTransactions = plaidResponse.data.transactions;

    if (plaidTransactions.length === 0) {
      return res.json({ success: true, count: 0 });
    }

    // Categorize with Claude AI (batch in groups of 20)
    const batchSize = 20;
    let allCategorized = [];

    for (let i = 0; i < plaidTransactions.length; i += batchSize) {
      const batch = plaidTransactions.slice(i, i + batchSize);
      const categorized = await categorizeTransactions(batch);
      allCategorized = allCategorized.concat(categorized);
    }

    // Match categorized data back to original transactions and store
    const toStore = plaidTransactions.map((plaidTx, index) => {
      const aiData = allCategorized[index] || {};

      return {
        user_id,
        plaid_transaction_id: plaidTx.transaction_id,
        name: plaidTx.name,
        vendor: aiData.vendor || plaidTx.merchant_name || plaidTx.name,
        amount: plaidTx.amount * -1, // Plaid uses negative for debits, we flip
        date: plaidTx.date,
        category: aiData.category || 'Uncategorized',
        is_deductible: aiData.is_deductible || false,
        deduction_percent: aiData.deduction_percent || 0,
        needs_review: aiData.needs_review || false,
        note: aiData.note || '',
        raw_category: plaidTx.personal_finance_category?.primary || '',
      };
    });

    // Upsert to Supabase (update if exists, insert if new)
    const { error: insertError } = await supabaseAdmin
      .from('transactions')
      .upsert(toStore, { onConflict: 'plaid_transaction_id' });

    if (insertError) throw insertError;

    // Update account balance
    const accounts = plaidResponse.data.accounts;
    if (accounts && accounts.length > 0) {
      const totalBalance = accounts.reduce((sum, a) => sum + (a.balances.current || 0), 0);
      await supabaseAdmin
        .from('bank_connections')
        .update({ balance: totalBalance, last_synced: new Date().toISOString() })
        .eq('user_id', user_id);
    }

    res.json({ success: true, count: toStore.length });
  } catch (error) {
    console.error('Sync error:', error.response?.data || error.message || error);
    res.status(500).json({ error: 'Failed to sync transactions' });
  }
};

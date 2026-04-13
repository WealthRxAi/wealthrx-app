const { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } = require('plaid');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Check environment variables
  if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET) {
    console.error('Missing Plaid env vars:', {
      hasClientId: !!process.env.PLAID_CLIENT_ID,
      hasSecret: !!process.env.PLAID_SECRET,
      env: process.env.PLAID_ENV
    });
    return res.status(500).json({ error: 'Plaid credentials not configured' });
  }

  try {
    const { user_id } = req.body;

    if (!user_id) {
      return res.status(400).json({ error: 'user_id is required' });
    }

    const config = new Configuration({
      basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
      baseOptions: {
        headers: {
          'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
          'PLAID-SECRET': process.env.PLAID_SECRET,
        },
      },
    });

    const plaidClient = new PlaidApi(config);

    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: user_id },
      client_name: 'WealthRx',
      products: [Products.Transactions],
      country_codes: [CountryCode.Us],
      language: 'en',
    });

    res.json({ link_token: response.data.link_token });
  } catch (error) {
    console.error('Plaid error details:', {
      message: error.message,
      response: error.response?.data,
      status: error.response?.status
    });
    res.status(500).json({
      error: 'Failed to create link token',
      details: error.response?.data?.error_message || error.message
    });
  }
};

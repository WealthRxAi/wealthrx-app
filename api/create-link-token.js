module.exports = async function handler(req, res) {
  var plaidModule;
  try {
    plaidModule = require('plaid');
  } catch (e) {
    return res.status(500).json({
      error: 'plaid package not found',
      message: e.message
    });
  }

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET) {
    return res.status(500).json({ error: 'Missing Plaid credentials' });
  }

  try {
    var Configuration = plaidModule.Configuration;
    var PlaidApi = plaidModule.PlaidApi;
    var PlaidEnvironments = plaidModule.PlaidEnvironments;
    var Products = plaidModule.Products;
    var CountryCode = plaidModule.CountryCode;

    var user_id = req.body ? req.body.user_id : 'test';

    var config = new Configuration({
      basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
      baseOptions: {
        headers: {
          'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
          'PLAID-SECRET': process.env.PLAID_SECRET
        }
      }
    });

    var client = new PlaidApi(config);

    var response = await client.linkTokenCreate({
      user: { client_user_id: user_id || 'test' },
      client_name: 'WealthRx',
      products: [Products.Transactions],
      country_codes: [CountryCode.Us],
      language: 'en'
    });

    return res.json({ link_token: response.data.link_token });
  } catch (e) {
    return res.status(500).json({
      error: 'Plaid API call failed',
      message: e.message,
      details: e.response ? e.response.data : null
    });
  }
};

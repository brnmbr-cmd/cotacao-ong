const axios = require('axios');
const cheerio = require('cheerio');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function timeout(ms) {
  return new Promise(resolve => setTimeout(() => resolve(null), ms));
}

function parseBrazilianPrice(text) {
  if (typeof text === 'number') return text;
  if (!text) return 0;
  const cleaned = String(text)
    .replace(/R\$|\s|\./g, '')
    .replace(',', '.');
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

async function fetchMercadoLivre(searchTerm, cep) {
  try {
    const searchUrl = `https://api.mercadolibre.com/sites/MLB/search?q=${encodeURIComponent(searchTerm)}&limit=1`;
    const { data } = await axios.get(searchUrl, { timeout: 3500 });
    const item = data.results && data.results[0];
    if (!item) return null;

    let shipping = 0;
    let deliveryDays = null;
    try {
      const shipUrl = `https://api.mercadolibre.com/items/${item.id}/shipping_options?zip_code=${encodeURIComponent(cep || '')}`;
      const ship = await axios.get(shipUrl, { timeout: 2000 });
      if (ship.data && ship.data.options && ship.data.options[0]) {
        shipping = ship.data.options[0].cost || 0;
        deliveryDays = ship.data.options[0].estimated_delivery_time
          ? ship.data.options[0].estimated_delivery_time.business_days
          : null;
      }
    } catch (e) {}

    const price = parseBrazilianPrice(item.price);
    const total = price + shipping;
    return {
      store: 'Mercado Livre',
      productName: item.title,
      productUrl: item.permalink,
      price,
      shipping,
      deliveryDays,
      total,
      image: item.thumbnail || ''
    };
  } catch (e) {
    return null;
  }
}

async function fetchAmazon(searchTerm) {
  try {
    const url = `https://www.amazon.com.br/s?k=${encodeURIComponent(searchTerm)}`;
    const { data } = await axios.get(url, {
      timeout: 3500,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8'
      }
    });
    const $ = cheerio.load(data);
    const result = $('[data-component-type="s-search-result"]').first();
    if (!result.length) return null;

    const title = result.find('h2').text().trim();
    const linkEl = result.find('h2 a').first();
    const link = linkEl.attr('href') ? 'https://www.amazon.com.br' + linkEl.attr('href') : '';
    const priceText = result.find('.a-price .a-offscreen').first().text().trim();
    const image = result.find('img.s-image').first().attr('src') || '';

    if (!title || !priceText) return null;
    const price = parseBrazilianPrice(priceText);
    return {
      store: 'Amazon',
      productName: title,
      productUrl: link,
      price,
      shipping: 0,
      deliveryDays: null,
      total: price,
      image
    };
  } catch (e) {
    return null;
  }
}

async function fetchMagalu(searchTerm) {
  try {
    const url = `https://www.magazineluiza.com.br/busca/${encodeURIComponent(searchTerm)}/`;
    const { data } = await axios.get(url, {
      timeout: 3500,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8'
      }
    });
    const $ = cheerio.load(data);
    const card = $('[data-testid="product-card"]').first();
    if (!card.length) return null;

    const title = card.find('[data-testid="product-title"]').text().trim() || card.find('h2').text().trim();
    const link = card.find('a').first().attr('href') || '';
    const fullLink = link && !link.startsWith('http') ? 'https://www.magazineluiza.com.br' + link : link;
    const priceText = card.find('[data-testid="product-price"]').text().trim() || card.find('.price-template').text().trim();
    const image = card.find('img').first().attr('src') || card.find('img').first().attr('data-src') || '';

    if (!title || !priceText) return null;
    const price = parseBrazilianPrice(priceText);
    return {
      store: 'Magalu',
      productName: title,
      productUrl: fullLink,
      price,
      shipping: 0,
      deliveryDays: null,
      total: price,
      image
    };
  } catch (e) {
    return null;
  }
}

async function extractTitleFromUrl(productUrl) {
  try {
    const { data } = await axios.get(productUrl, {
      timeout: 3000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    const match = data.match(/<title[^>]*>([^<]+)<\/title>/i);
    return match ? match[1].trim() : '';
  } catch (e) {
    return '';
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const searchTerm = body.searchTerm || '';
    const productUrl = body.productUrl || '';
    const cep = body.cep || '';

    let term = searchTerm;
    if (!term && productUrl) {
      term = await Promise.race([extractTitleFromUrl(productUrl), timeout(3000)]);
    }
    if (!term) {
      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ quotes: [], error: 'No search term provided' })
      };
    }

    const [ml, am, mg] = await Promise.all([
      Promise.race([fetchMercadoLivre(term, cep), timeout(4000)]),
      Promise.race([fetchAmazon(term), timeout(4000)]),
      Promise.race([fetchMagalu(term), timeout(4000)])
    ]);

    const quotes = [ml, am, mg].filter(Boolean).sort((a, b) => a.total - b.total);

    if (quotes.length === 0) {
      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ quotes: [], error: 'No results found from any retailer' })
      };
    }

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ quotes })
    };
  } catch (e) {
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ quotes: [], error: 'Function error: ' + e.message })
    };
  }
};

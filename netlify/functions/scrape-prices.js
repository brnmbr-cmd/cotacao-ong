// Netlify Function: scrape-prices.js
// Usa fetch nativo do Node 18+ (sem axios) para evitar erro "File is not defined"
const cheerio = require('cheerio');

// Cabeçalhos de navegador para simular acesso humano durante o scraping
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8'
};

// Cabeçalhos CORS padrão para todas as respostas
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

// Helper: fetch nativo com timeout usando AbortController
async function fetchWithTimeout(url, options = {}, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// Helper: resolve como null após X milissegundos (usado no Promise.race)
function timeout(ms) {
  return new Promise(resolve => setTimeout(() => resolve(null), ms));
}

// Converte preço brasileiro "R$ 1.299,90" para número 1299.90
function parseBrazilianPrice(raw) {
  if (!raw) return 0;
  const cleaned = String(raw)
    .replace(/R\$/gi, '')
    .replace(/\s/g, '')
    .replace(/\./g, '')
    .replace(',', '.');
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

// Busca o título da página a partir da URL (usando regex, sem cheerio)
async function extractTitleFromUrl(url) {
  try {
    const res = await fetchWithTimeout(url, { headers: BROWSER_HEADERS }, 4000);
    const html = await res.text();
    const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (match && match[1]) {
      return match[1].trim();
    }
    return null;
  } catch (e) {
    return null;
  }
}

// Busca produto no Mercado Livre via API JSON
async function fetchMercadoLivre(searchTerm, cep) {
  try {
    const searchUrl = `https://api.mercadolibre.com/sites/MLB/search?q=${encodeURIComponent(searchTerm)}&limit=1`;
    const searchRes = await fetchWithTimeout(searchUrl, {}, 4000);
    const searchData = await searchRes.json();

    const item = searchData && searchData.results && searchData.results[0];
    if (!item) return null;

    const price = parseBrazilianPrice(String(item.price || 0));
    let shipping = 0;
    let deliveryDays = null;

    // Tenta buscar frete pelo CEP; se falhar, mantém shipping = 0
    try {
      const shippingUrl = `https://api.mercadolibre.com/items/${item.id}/shipping_options?zip_code=${encodeURIComponent(cep || '')}`;
      const shippingRes = await fetchWithTimeout(shippingUrl, {}, 4000);
      const shippingData = await shippingRes.json();
      if (shippingData && shippingData.options && shippingData.options.length > 0) {
        const opt = shippingData.options[0];
        shipping = parseBrazilianPrice(String(opt.cost || opt.price || 0));
        if (opt.estimated_delivery_time && opt.estimated_delivery_time.shipping) {
          deliveryDays = opt.estimated_delivery_time.shipping.days || null;
        }
      }
    } catch (e) {
      shipping = 0;
    }

    return {
      store: 'Mercado Livre',
      productName: item.title || '',
      productUrl: item.permalink || '',
      price,
      shipping,
      deliveryDays,
      total: price + shipping,
      image: item.thumbnail || ''
    };
  } catch (e) {
    return null;
  }
}

// Busca produto na Amazon Brasil via scraping HTML
async function fetchAmazon(searchTerm) {
  try {
    const url = `https://www.amazon.com.br/s?k=${encodeURIComponent(searchTerm)}`;
    const res = await fetchWithTimeout(url, { headers: BROWSER_HEADERS }, 4000);
    const html = await res.text();
    const $ = cheerio.load(html);

    const result = $('[data-component-type="s-search-result"]').first();
    if (result.length === 0) return null;

    const title = result.find('h2').text().trim();
    const linkEl = result.find('h2 a').first();
    const link = linkEl.attr('href') || '';
    const image = result.find('img.s-image').first().attr('src') || '';
    const priceText = result.find('.a-price .a-offscreen').first().text().trim();
    const price = parseBrazilianPrice(priceText);

    if (!title && !price) return null;

    return {
      store: 'Amazon',
      productName: title,
      productUrl: link ? `https://www.amazon.com.br${link}` : '',
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

// Busca produto no Magalu via scraping HTML
async function fetchMagalu(searchTerm) {
  try {
    const url = `https://www.magazineluiza.com.br/busca/${encodeURIComponent(searchTerm)}/`;
    const res = await fetchWithTimeout(url, { headers: BROWSER_HEADERS }, 4000);
    const html = await res.text();
    const $ = cheerio.load(html);

    // Seletores comuns do Magalu; tenta múltiplas variações
    const product = $('[data-testid="product-card"]').first();
    const fallback = $('a[href*="/p/"]').first();
    const el = product.length > 0 ? product : fallback;
    if (el.length === 0) return null;

    const title = el.find('h2, h3, [data-testid="product-title"]').first().text().trim() || el.attr('title') || '';
    const link = el.is('a') ? el.attr('href') : el.find('a').first().attr('href') || '';
    const image = el.find('img').first().attr('src') || el.find('img').first().attr('data-src') || '';
    const priceText = el.find('[data-testid="price-value"], .price-template__text, .p-price').first().text().trim();
    const price = parseBrazilianPrice(priceText);

    if (!title && !price) return null;

    return {
      store: 'Magalu',
      productName: title,
      productUrl: link ? (link.startsWith('http') ? link : `https://www.magazineluiza.com.br${link}`) : '',
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

// Handler principal da Netlify Function (CommonJS)
exports.handler = async (event) => {
  // Responde preflight CORS
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: ''
    };
  }

  // Apenas POST é aceito
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: CORS_HEADERS,
      body: JSON.stringify({ quotes: [], error: 'Método não permitido' })
    };
  }

  try {
    // Parse do corpo da requisição
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch (e) {
      body = {};
    }

    let { searchTerm, productUrl, cep } = body;

    // Se não houver searchTerm mas houver URL, extrai título da página
    if (!searchTerm && productUrl) {
      const extracted = await extractTitleFromUrl(productUrl);
      searchTerm = extracted || '';
    }

    if (!searchTerm) {
      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ quotes: [], error: 'Termo de busca não fornecido' })
      };
    }

    // Executa as 3 lojas em paralelo com timeout de 4s cada
    const args = { searchTerm, cep };
    const [ml, amazon, magalu] = await Promise.all([
      Promise.race([fetchMercadoLivre(args.searchTerm, args.cep), timeout(4000)]),
      Promise.race([fetchAmazon(args.searchTerm), timeout(4000)]),
      Promise.race([fetchMagalu(args.searchTerm), timeout(4000)])
    ]);

    // Filtra resultados nulos e ordena pelo total (preço + frete)
    const quotes = [ml, amazon, magalu]
      .filter(q => q !== null)
      .sort((a, b) => a.total - b.total);

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ quotes })
    };
  } catch (error) {
    // Sempre retorna 200, mesmo em caso de erro
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ quotes: [], error: String(error && error.message ? error.message : error) })
    };
  }
};

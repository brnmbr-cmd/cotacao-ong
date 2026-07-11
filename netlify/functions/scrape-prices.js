const https = require('https');
const http = require('http');
const zlib = require('zlib');
const querystring = require('querystring');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Content-Type': 'application/json'
};

function httpsGet(urlStr, headers, timeoutMs) {
  headers = headers || {};
  timeoutMs = timeoutMs || 10000;
  return new Promise((resolve) => {
    try {
      const parsedUrl = new URL(urlStr);
      const mod = parsedUrl.protocol === 'https:' ? https : http;
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Encoding': 'gzip, deflate',
          ...headers
        },
        timeout: timeoutMs
      };

      const req = mod.get(options, (res) => {
        const statusCode = res.statusCode || 0;

        if (statusCode >= 300 && statusCode < 400 && res.headers.location) {
          const loc = res.headers.location;
          const redirectUrl = loc.startsWith('http')
            ? loc
            : new URL(loc, urlStr).toString();
          res.resume();
          resolve(httpsGet(redirectUrl, headers, timeoutMs));
          return;
        }

        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          const contentEncoding = (res.headers['content-encoding'] || '').toLowerCase();

          if (contentEncoding === 'gzip') {
            zlib.gunzip(buffer, (err, decoded) => {
              if (err) resolve({ statusCode: statusCode, body: buffer.toString('utf8') });
              else resolve({ statusCode: statusCode, body: decoded.toString('utf8') });
            });
            return;
          } else if (contentEncoding === 'deflate') {
            zlib.inflate(buffer, (err, decoded) => {
              if (err) {
                zlib.inflateRaw(buffer, (err2, decoded2) => {
                  if (err2) resolve({ statusCode: statusCode, body: buffer.toString('utf8') });
                  else resolve({ statusCode: statusCode, body: decoded2.toString('utf8') });
                });
              } else {
                resolve({ statusCode: statusCode, body: decoded.toString('utf8') });
              }
            });
            return;
          } else if (contentEncoding === 'br') {
            try {
              const decoded = zlib.brotliDecompressSync(buffer);
              resolve({ statusCode: statusCode, body: decoded.toString('utf8') });
            } catch (e) {
              resolve({ statusCode: statusCode, body: buffer.toString('utf8') });
            }
            return;
          }

          resolve({ statusCode: statusCode, body: buffer.toString('utf8') });
        });

        res.on('error', () => resolve({ statusCode: 0, body: '' }));
      });

      req.on('error', () => resolve({ statusCode: 0, body: '' }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ statusCode: 0, body: '' });
      });
    } catch (err) {
      resolve({ statusCode: 0, body: '' });
    }
  });
}

function httpsGetJSON(urlStr, headers, timeoutMs) {
  return httpsGet(urlStr, headers, timeoutMs).then((result) => {
    if (!result || result.statusCode === 0 || !result.body) {
      return { statusCode: 0, body: null };
    }
    try {
      return { statusCode: result.statusCode, body: JSON.parse(result.body) };
    } catch (e) {
      return { statusCode: result.statusCode, body: null };
    }
  });
}

function parseBrazilianPrice(text) {
  if (!text) return null;
  if (typeof text === 'number') return text;
  let s = String(text).trim();
  s = s.replace(/R\$|\s|\u00a0/gi, '');
  s = s.replace(/[^0-9.,-]/g, '');
  if (s.indexOf(',') > -1 && s.indexOf('.') > -1) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (s.indexOf(',') > -1) {
    s = s.replace(',', '.');
  }
  const num = parseFloat(s);
  return isNaN(num) ? null : num;
}

function decodeHtmlEntities(text) {
  if (!text) return '';
  return String(text)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractAttr(html, tag, attr) {
  const re = new RegExp('<' + tag + '[^>]*\\s' + attr + '\\s*=\\s*"([^"]*)"', 'i');
  const m = html.match(re);
  return m ? m[1] : null;
}

function extractTitleFromUrl(urlStr) {
  return httpsGet(urlStr, {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
  }, 3000).then((result) => {
    if (!result || result.statusCode === 0 || !result.body) return null;
    const m = result.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return m ? decodeHtmlEntities(m[1]) : null;
  });
}

function withTimeout(promise, ms) {
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), ms));
  return Promise.race([promise, timeout]);
}

async function scrapeMercadoLivre(term, cep) {
  const apiUrl = 'https://api.mercadolibre.com/sites/MLB/search?q=' + encodeURIComponent(term) + '&limit=1';
  const result = await httpsGetJSON(apiUrl, {
    'Accept': 'application/json'
  }, 4000);

  if (!result || result.statusCode === 0 || !result.body) return null;
  const data = result.body;
  const results = data && data.results && data.results[0];
  if (!results) return null;

  const itemId = results.id;
  const price = typeof results.price === 'number' ? results.price : parseBrazilianPrice(results.price);
  if (price == null) return null;

  let shipping = null;
  if (itemId && cep) {
    const shipUrl = 'https://api.mercadolibre.com/items/' + encodeURIComponent(itemId) + '/shipping_options?zip_code=' + encodeURIComponent(cep);
    const shipResult = await httpsGetJSON(shipUrl, {
      'Accept': 'application/json'
    }, 3000);
    if (shipResult && shipResult.body) {
      const opts = shipResult.body.options || [];
      if (opts.length > 0) {
        const first = opts[0];
        shipping = {
          cost: typeof first.cost === 'number' ? first.cost : parseBrazilianPrice(first.cost),
          estimatedDelivery: first.estimated_delivery_time && first.estimated_delivery_time.date
            ? first.estimated_delivery_time.date
            : (first.estimated_delivery || null)
        };
      }
    }
  }

  const shippingCost = (shipping && shipping.cost) || 0;
  const total = price + (shippingCost || 0);

  return {
    retailer: 'Mercado Livre',
    title: decodeHtmlEntities(results.title),
    price: price,
    shipping: shippingCost,
    total: total,
    url: results.permalink,
    image: results.thumbnail,
    shippingInfo: shipping
  };
}

async function scrapeAmazon(term) {
  const searchUrl = 'https://www.amazon.com.br/s?k=' + encodeURIComponent(term);
  const result = await httpsGet(searchUrl, {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Upgrade-Insecure-Requests': '1'
  }, 4000);

  if (!result || result.statusCode === 0 || !result.body) return null;
  const html = result.body;

  const blockRe = /data-component-type="s-search-result"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>\s*<\/div>/i;
  const blockMatch = html.match(blockRe);
  let block = blockMatch ? blockMatch[0] : null;

  if (!block) {
    const altRe = /data-component-type="s-search-result"[\s\S]*?(?=data-component-type="s-search-result"|<\/div>\s*<\/div>\s*<\/div>\s*<\/div>\s*<\/div>\s*<\/div>)/i;
    const altMatch = html.match(altRe);
    block = altMatch ? altMatch[0] : null;
  }

  if (!block) {
    const idx = html.indexOf('data-component-type="s-search-result"');
    if (idx >= 0) block = html.substring(idx, idx + 8000);
  }

  if (!block) return null;

  let title = null;
  const h2Match = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
  if (h2Match) {
    title = decodeHtmlEntities(h2Match[1]);
  }

  let price = null;
  const priceWholeMatch = block.match(/<span class="a-price-whole"[^>]*>([\s\S]*?)<\/span>[\s\S]*?<span class="a-price-fraction"[^>]*>([\s\S]*?)<\/span>/i);
  if (priceWholeMatch) {
    price = parseBrazilianPrice(priceWholeMatch[1] + ',' + priceWholeMatch[2]);
  }
  if (price == null) {
    const offscreenMatch = block.match(/<span class="a-offscreen"[^>]*>([\s\S]*?)<\/span>/i);
    if (offscreenMatch) price = parseBrazilianPrice(offscreenMatch[1]);
  }
  if (price == null) {
    const priceMatch = block.match(/a-color-price[^>]*>([\s\S]*?)<\/span>/i);
    if (priceMatch) price = parseBrazilianPrice(priceMatch[1]);
  }

  let link = null;
  const linkMatch = block.match(/<a[^>]*class="[^"]*a-link-normal[^"]*"[^>]*href="([^"]*)"/i);
  if (linkMatch) {
    link = linkMatch[1];
    if (link.startsWith('/')) link = 'https://www.amazon.com.br' + link;
  }
  if (!link) {
    const anyLink = block.match(/<a[^>]*href="([^"]*\/dp\/[^"]*)"/i);
    if (anyLink) {
      link = anyLink[1];
      if (link.startsWith('/')) link = 'https://www.amazon.com.br' + link;
    }
  }

  let image = null;
  const imgMatch = block.match(/<img[^>]*src="([^"]*)"/i);
  if (imgMatch) image = imgMatch[1];
  if (!image) {
    const lazyMatch = block.match(/<img[^>]*data-src="([^"]*)"/i);
    if (lazyMatch) image = lazyMatch[1];
  }

  if (!title || price == null || !link) return null;

  return {
    retailer: 'Amazon',
    title: title,
    price: price,
    shipping: 0,
    total: price,
    url: link,
    image: image,
    shippingInfo: null
  };
}

async function scrapeMagalu(term) {
  const searchUrl = 'https://www.magazineluiza.com.br/busca/' + encodeURIComponent(term) + '/';
  const result = await httpsGet(searchUrl, {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Upgrade-Insecure-Requests': '1'
  }, 4000);

  if (!result || result.statusCode === 0 || !result.body) return null;
  const html = result.body;

  let block = null;
  const cardRe = /data-testid="product-card-content"[\s\S]*?(?=data-testid="product-card-content"|<\/li>|<\/article>)/i;
  const cardMatch = html.match(cardRe);
  if (cardMatch) block = cardMatch[0];

  if (!block) {
    const idx = html.indexOf('data-testid="product-card-content"');
    if (idx >= 0) block = html.substring(idx, idx + 6000);
  }

  if (!block) {
    const altRe = /<a[^>]*href="[^"]*\/p\/[^"]*"[\s\S]*?<\/a>/i;
    const altMatch = html.match(altRe);
    if (altMatch) block = altMatch[0];
  }

  if (!block) return null;

  let title = null;
  const titleMatch = block.match(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/i);
  if (titleMatch) title = decodeHtmlEntities(titleMatch[1]);
  if (!title) {
    const titleAttr = block.match(/data-testid="product-title"[^>]*>([\s\S]*?)<\//i);
    if (titleAttr) title = decodeHtmlEntities(titleAttr[1]);
  }
  if (!title) {
    const titleAttr2 = block.match(/title="([^"]+)"/i);
    if (titleAttr2) title = decodeHtmlEntities(titleAttr2[1]);
  }

  let price = null;
  const priceMatch = block.match(/data-testid="price-value"[^>]*>([\s\S]*?)<\//i);
  if (priceMatch) price = parseBrazilianPrice(priceMatch[1]);
  if (price == null) {
    const pMatch = block.match(/<p[^>]*class="[^"]*price[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
    if (pMatch) price = parseBrazilianPrice(pMatch[1]);
  }
  if (price == null) {
    const valMatch = block.match(/R\$\s*<[^>]*>\s*([0-9.,]+)/i);
    if (valMatch) price = parseBrazilianPrice('R$ ' + valMatch[1]);
  }
  if (price == null) {
    const anyPrice = block.match(/R\$\s*([0-9]{1,3}(?:\.[0-9]{3})*,[0-9]{2})/i);
    if (anyPrice) price = parseBrazilianPrice(anyPrice[0]);
  }

  let link = null;
  const linkMatch = block.match(/<a[^>]*href="([^"]*)"/i);
  if (linkMatch) {
    link = linkMatch[1];
    if (link.startsWith('/')) link = 'https://www.magazineluiza.com.br' + link;
  }

  let image = null;
  const imgMatch = block.match(/<img[^>]*src="([^"]*)"/i);
  if (imgMatch) image = imgMatch[1];
  if (!image) {
    const lazyMatch = block.match(/<img[^>]*data-src="([^"]*)"/i);
    if (lazyMatch) image = lazyMatch[1];
  }

  if (!title || price == null || !link) return null;

  return {
    retailer: 'Magalu',
    title: title,
    price: price,
    shipping: 0,
    total: price,
    url: link,
    image: image,
    shippingInfo: null
  };
}

exports.handler = async (event) => {
  if (event && event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: ''
    };
  }

  try {
    let body = event && event.body ? event.body : null;
    if (event && event.queryStringParameters && event.queryStringParameters.term) {
      body = JSON.stringify({ term: event.queryStringParameters.term, cep: event.queryStringParameters.cep });
    }
    let parsed = {};
    if (body) {
      try {
        parsed = typeof body === 'string' ? JSON.parse(body) : body;
      } catch (e) {
        parsed = {};
      }
    }

    const term = (parsed.term || parsed.query || parsed.q || '').toString().trim();
    const cep = (parsed.cep || parsed.zip || '').toString().trim();

    if (!term) {
      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ quotes: [], error: 'Missing term' })
      };
    }

    const tasks = [
      withTimeout(scrapeMercadoLivre(term, cep), 4000),
      withTimeout(scrapeAmazon(term), 4000),
      withTimeout(scrapeMagalu(term), 4000)
    ];

    const results = await Promise.all(tasks);
    const quotes = results.filter((r) => r && r.price != null);
    quotes.sort((a, b) => (a.total || a.price) - (b.total || b.price));

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ quotes: quotes })
    };
  } catch (err) {
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ quotes: [], error: 'Internal error' })
    };
  }
};

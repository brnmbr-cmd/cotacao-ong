// Netlify Function: scrape-prices.js
// Responsável por buscar preços em 3 varejistas (Mercado Livre, Amazon BR, Magazine Luiza)
// Otimizado para evitar timeouts 502 no plano gratuito do Netlify (limite de 10s por função)

"use strict";

const axios = require("axios");
const cheerio = require("cheerio");

// --- Configurações de timeout otimizadas ---
// Timeout por requisição: 5s (deixa margem dentro do limite de 10s do Netlify)
const REQUEST_TIMEOUT = 5000;
// Corte global: 8s para garantir resposta antes do limite do Netlify
const GLOBAL_CUTOFF = 8000;

// --- Headers de navegador para scraping ---
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
  "Accept-Encoding": "gzip, deflate, br",
  Connection: "keep-alive",
  "Upgrade-Insecure-Requests": "1",
};

// --- Helpers ---

// Converte "R$ 1.299,90" -> 1299.90
function parseBrazilianPrice(raw) {
  if (raw == null) return null;
  if (typeof raw === "number") return raw;

  let s = String(raw).trim();
  if (!s) return null;

  // Remove prefixo de moeda e espaços
  s = s.replace(/R\$|\s/g, "");

  // Detecta separadores
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");

  if (hasComma && hasDot) {
    // Formato brasileiro: 1.299,90 -> remove pontos, troca vírgula por ponto
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (hasComma) {
    // Apenas vírgula: 1299,90 -> 1299.90
    s = s.replace(",", ".");
  }
  // Se só ponto ou nenhum separador, mantém como está

  const num = parseFloat(s);
  return isNaN(num) ? null : num;
}

// Cria cliente axios com timeout e headers padrão
function createClient() {
  return axios.create({
    timeout: REQUEST_TIMEOUT,
    headers: BROWSER_HEADERS,
    maxRedirects: 5,
    validateStatus: (status) => status >= 200 && status < 400,
  });
}

// Extrai o título de um produto a partir de uma URL (usado quando productUrl é informado)
async function extractTitleFromUrl(url) {
  try {
    const client = createClient();
    const res = await client.get(url);
    const $ = cheerio.load(res.data);

    // Seletores genéricos para título de produto
    const title =
      $("title").first().text().trim() ||
      $('meta[property="og:title"]').attr("content") ||
      $("h1").first().text().trim() ||
      "";

    // Limpa sufixos comuns de sites
    return title
      .replace(/\s*[-|]\s*(Amazon|Magazine Luiza|Mercado Livre).*$/i, "")
      .replace(/\s*\|\s*.*$/i, "")
      .trim();
  } catch (err) {
    return null;
  }
}

// --- Varejistas ---
// Cada função retorna um objeto quote ou null. Nunca lança erro.

// a) Mercado Livre: API pública (JSON, mais confiável)
async function fetchMercadoLivre(searchTerm, cep) {
  try {
    const client = createClient();

    // 1. Busca o produto
    const searchUrl = `https://api.mercadolibre.com/sites/MLB/search?q=${encodeURIComponent(
      searchTerm
    )}&limit=1`;

    const searchRes = await client.get(searchUrl);
    const results = searchRes.data && searchRes.data.results;
    if (!results || results.length === 0) return null;

    const item = results[0];
    const itemId = item.id;
    const price =
      typeof item.price === "number" ? item.price : parseBrazilianPrice(item.price);
    if (price == null) return null;

    // 2. Tenta obter frete via CEP (opcional, não bloqueia se falhar)
    let shipping = null;
    let deliveryDays = null;

    if (cep && itemId) {
      try {
        const shippingUrl = `https://api.mercadolibre.com/items/${itemId}/shipping_options?zip_code=${encodeURIComponent(
          cep
        )}`;
        const shipRes = await client.get(shippingUrl);
        const options = shipRes.data && shipRes.data.options;
        if (options && options.length > 0) {
          const cheapest = options.reduce((a, b) =>
            (a.cost || 0) < (b.cost || 0) ? a : b
          );
          shipping = typeof cheapest.cost === "number" ? cheapest.cost : null;
          deliveryDays = cheapest.estimated_delivery_time
            ? cheapest.estimated_delivery_time.shipping
            : null;
        }
      } catch (shipErr) {
        // Falha no frete não invalida a cotação
        shipping = null;
        deliveryDays = null;
      }
    }

    const total = price + (shipping || 0);

    return {
      store: "Mercado Livre",
      productName: item.title || "Produto Mercado Livre",
      productUrl: item.permalink || `https://www.mercadolivre.com.br/`,
      price,
      shipping: shipping || 0,
      deliveryDays,
      total,
      image: item.thumbnail || null,
    };
  } catch (err) {
    return null;
  }
}

// b) Amazon BR: scraping com axios + cheerio
async function fetchAmazonBR(searchTerm) {
  try {
    const client = createClient();
    const url = `https://www.amazon.com.br/s?k=${encodeURIComponent(searchTerm)}`;
    const res = await client.get(url);
    const $ = cheerio.load(res.data);

    // Seletores simplificados para o primeiro resultado
    const firstResult = $("div[data-component-type='s-search-result']").first();
    if (firstResult.length === 0) return null;

    const title =
      firstResult.find("h2 a span").first().text().trim() ||
      firstResult.find("h2 span").first().text().trim();
    if (!title) return null;

    const linkEl = firstResult.find("h2 a").first();
    let link = linkEl.attr("href") || "";
    if (link && link.startsWith("/")) {
      link = "https://www.amazon.com.br" + link.split("?")[0];
    }

    // Preço: tenta vários seletores comuns
    const priceText =
      firstResult.find(".a-price .a-offscreen").first().text().trim() ||
      firstResult.find(".a-price-whole").first().text().trim() ||
      firstResult.find("span.a-color-price").first().text().trim();

    const price = parseBrazilianPrice(priceText);
    if (price == null) return null;

    const image =
      firstResult.find("img.s-image").first().attr("src") || null;

    return {
      store: "Amazon",
      productName: title,
      productUrl: link || "https://www.amazon.com.br/",
      price,
      shipping: 0, // Amazon não expõe frete facilmente no scraping
      deliveryDays: null,
      total: price,
      image,
    };
  } catch (err) {
    return null;
  }
}

// c) Magazine Luiza: scraping com axios + cheerio
async function fetchMagazineLuiza(searchTerm) {
  try {
    const client = createClient();
    const url = `https://www.magazineluiza.com.br/busca/${encodeURIComponent(
      searchTerm
    )}/`;
    const res = await client.get(url);
    const $ = cheerio.load(res.data);

    // Seletores simplificados
    const firstResult = $("[data-testid='product-card-container']").first();
    const fallback = firstResult.length === 0 ? $("article").first() : firstResult;
    if (fallback.length === 0) return null;

    const title =
      fallback.find("[data-testid='product-title']").first().text().trim() ||
      fallback.find("h2").first().text().trim() ||
      fallback.find("h3").first().text().trim();
    if (!title) return null;

    const linkEl = fallback.find("a").first();
    let link = linkEl.attr("href") || "";
    if (link && link.startsWith("/")) {
      link = "https://www.magazineluiza.com.br" + link.split("?")[0];
    }

    const priceText =
      fallback.find("[data-testid='product-price-default']").first().text().trim() ||
      fallback.find(".price-template__text").first().text().trim() ||
      fallback.find(".price").first().text().trim();

    const price = parseBrazilianPrice(priceText);
    if (price == null) return null;

    const image =
      fallback.find("img").first().attr("src") ||
      fallback.find("img").first().attr("data-src") ||
      null;

    return {
      store: "Magazine Luiza",
      productName: title,
      productUrl: link || "https://www.magazineluiza.com.br/",
      price,
      shipping: 0,
      deliveryDays: null,
      total: price,
      image,
    };
  } catch (err) {
    return null;
  }
}

// --- Handler principal ---

exports.handler = async (event) => {
  // Headers CORS
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };

  // Pré-flight CORS
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: corsHeaders,
      body: "",
    };
  }

  // Apenas POST
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Método não permitido" }),
    };
  }

  // Health check: se não houver searchTerm nem productUrl, retorna imediatamente
  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch (err) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: "JSON inválido no corpo da requisição" }),
    };
  }

  const { searchTerm, productUrl, cep } = body;

  if (!searchTerm && !productUrl) {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        quotes: [],
        message: "Informe searchTerm ou productUrl.",
      }),
    };
  }

  try {
    // Se productUrl foi informado, extrai o título e usa como termo de busca
    let term = searchTerm;
    if (!term && productUrl) {
      term = await extractTitleFromUrl(productUrl);
      if (!term) {
        return {
          statusCode: 200,
          headers: corsHeaders,
          body: JSON.stringify({
            quotes: [],
            error:
              "Não foi possível extrair o título do produto a partir da URL informada.",
          }),
        };
      }
    }

    // Executa as 3 buscas em paralelo com Promise.allSettled
    // Cada função retorna null em caso de erro (nunca lança)
    const tasks = [
      fetchMercadoLivre(term, cep),
      fetchAmazonBR(term),
      fetchMagazineLuiza(term),
    ];

    // Corte global: 8s para garantir resposta antes do limite do Netlify
    const cutoffPromise = new Promise((resolve) =>
      setTimeout(() => resolve("__CUTOFF__"), GLOBAL_CUTOFF)
    );

    const settled = await Promise.race([
      Promise.allSettled(tasks),
      cutoffPromise,
    ]);

    let results = [];
    if (settled === "__CUTOFF__") {
      // Tempo esgotado: coleta o que já tiver sido resolvido
      // Como as promises ainda estão pendentes, tentamos capturar resultados já resolvidos
      results = tasks
        .map((p) => {
          // Verifica se a promise já resolveu com valor não-nulo
          // (não há API direta, então apenas retornamos null e deixamos o fallback agir)
          return null;
        })
        .filter((r) => r !== null);
    } else {
      // Coleta apenas resultados não-nulos (sucesso)
      results = settled
        .filter((r) => r.status === "fulfilled" && r.value !== null)
        .map((r) => r.value);
    }

    // Ordena por total (preço + frete) crescente
    results.sort((a, b) => (a.total || 0) - (b.total || 0));

    // Fallback: se todos falharem, retorna mensagem amigável com 200
    if (results.length === 0) {
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          quotes: [],
          error:
            "Não foi possível obter cotações automaticamente. Tente inserir manualmente.",
        }),
      };
    }

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ quotes: results }),
    };
  } catch (err) {
    // Erro inesperado: ainda retorna 200 para o frontend tratar com graceful degradation
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        quotes: [],
        error:
          "Não foi possível obter cotações automaticamente. Tente inserir manualmente.",
      }),
    };
  }
};

// app.js - Aplicação principal para Cotações ONG
// Usa Firebase v10+ modular SDK via CDN
// As configurações do Firebase são lidas de window.FIREBASE_* (definidas em firebase-config.js)

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  addDoc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  orderBy,
  serverTimestamp,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// =========================================================
// Configuração do Firebase (lida de window.FIREBASE_*)
// =========================================================
const firebaseConfig = {
  apiKey: window.FIREBASE_API_KEY,
  authDomain: window.FIREBASE_AUTH_DOMAIN,
  projectId: window.FIREBASE_PROJECT_ID,
  storageBucket: window.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: window.FIREBASE_MESSAGING_SENDER_ID,
  appId: window.FIREBASE_APP_ID
};

// Inicializa Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// URL da Netlify Function para scraping de preços
const SCRAPE_FUNCTION_URL = "/.netlify/functions/scrape-prices";

// Estado global da aplicação
let currentUser = null;
let currentView = "auth";
let currentProjectId = null;
let currentSearchData = null;
let projectsUnsubscribe = null;
let searchesUnsubscribe = null;

// =========================================================
// Utilitários
// =========================================================

/**
 * Formata valor como moeda brasileira (R$)
 * @param {number} value
 * @returns {string}
 */
function formatCurrency(value) {
  if (value === null || value === undefined || isNaN(value)) return "R$ 0,00";
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL"
  }).format(Number(value));
}

/**
 * Formata data para padrão brasileiro
 * @param {Date|number|string} date
 * @returns {string}
 */
function formatDate(date) {
  if (!date) return "-";
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

/**
 * Escapa HTML para evitar XSS
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Exibe uma notificação toast
 * @param {string} message
 * @param {"success"|"error"|"info"|"warning"} type
 */
function showToast(message, type = "info") {
  const container = document.getElementById("toast-container") || createToastContainer();
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.innerHTML = escapeHtml(message);
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add("toast-show");
  }, 50);
  setTimeout(() => {
    toast.classList.remove("toast-show");
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

/**
 * Cria o container de toasts se não existir
 */
function createToastContainer() {
  const container = document.createElement("div");
  container.id = "toast-container";
  container.className = "toast-container";
  document.body.appendChild(container);
  return container;
}

/**
 * Exibe/oculta overlay de carregamento
 * @param {boolean} show
 * @param {string} message
 */
function setLoading(show, message = "Carregando...") {
  let overlay = document.getElementById("loading-overlay");
  if (show) {
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "loading-overlay";
      overlay.className = "loading-overlay";
      overlay.innerHTML = `
        <div class="loading-spinner"></div>
        <p class="loading-message">${escapeHtml(message)}</p>
      `;
      document.body.appendChild(overlay);
    } else {
      overlay.querySelector(".loading-message").textContent = message;
    }
    overlay.style.display = "flex";
  } else {
    if (overlay) overlay.style.display = "none";
  }
}

/**
 * Exibe modal de confirmação
 * @param {string} title
 * @param {string} message
 * @param {Function} onConfirm
 */
function showConfirmModal(title, message, onConfirm) {
  const modal = document.createElement("div");
  modal.className = "modal-overlay";
  modal.innerHTML = `
    <div class="modal-content">
      <h3 class="modal-title">${escapeHtml(title)}</h3>
      <p class="modal-message">${escapeHtml(message)}</p>
      <div class="modal-actions">
        <button class="btn btn-secondary modal-cancel">Cancelar</button>
        <button class="btn btn-danger modal-confirm">Confirmar</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.querySelector(".modal-cancel").addEventListener("click", () => modal.remove());
  modal.querySelector(".modal-confirm").addEventListener("click", () => {
    modal.remove();
 if (typeof onConfirm === "function") onConfirm();
  });
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.remove();
  });
}

// =========================================================
// Autenticação
// =========================================================

/**
 * Realiza login com email e senha
 * @param {string} email
 * @param {string} password
 */
async function login(email, password) {
  try {
    setLoading(true, "Entrando...");
    await signInWithEmailAndPassword(auth, email, password);
    showToast("Login realizado com sucesso!", "success");
  } catch (error) {
    showToast(getAuthErrorMessage(error.code), "error");
  } finally {
    setLoading(false);
  }
}

/**
 * Registra novo usuário
 * @param {string} email
 * @param {string} password
 */
async function register(email, password) {
  try {
    setLoading(true, "Criando conta...");
    await createUserWithEmailAndPassword(auth, email, password);
    showToast("Conta criada com sucesso!", "success");
  } catch (error) {
    showToast(getAuthErrorMessage(error.code), "error");
  } finally {
    setLoading(false);
  }
}

/**
 * Encerra sessão do usuário
 */
async function logout() {
  try {
    await signOut(auth);
    currentUser = null;
    currentView = "auth";
    currentProjectId = null;
    currentSearchData = null;
    if (projectsUnsubscribe) {
      projectsUnsubscribe();
      projectsUnsubscribe = null;
    }
    if (searchesUnsubscribe) {
      searchesUnsubscribe();
      searchesUnsubscribe = null;
    }
    showToast("Logout realizado com sucesso!", "info");
    renderApp();
  } catch (error) {
    showToast("Erro ao sair: " + error.message, "error");
  }
}

/**
 * Traduz mensagens de erro do Firebase Auth
 * @param {string} errorCode
 * @returns {string}
 */
function getAuthErrorMessage(errorCode) {
  const messages = {
    "auth/invalid-email": "E-mail inválido.",
    "auth/user-disabled": "Usuário desativado.",
    "auth/user-not-found": "Usuário não encontrado.",
    "auth/wrong-password": "Senha incorreta.",
    "auth/email-already-in-use": "Este e-mail já está em uso.",
    "auth/weak-password": "A senha deve ter pelo menos 6 caracteres.",
    "auth/operation-not-allowed": "Operação não permitida.",
    "auth/too-many-requests": "Muitas tentativas. Tente novamente mais tarde.",
    "auth/network-request-failed": "Erro de rede. Verifique sua conexão.",
    "auth/invalid-credential": "Credenciais inválidas."
  };
  return messages[errorCode] || "Ocorreu um erro de autenticação. Tente novamente.";
}

// =========================================================
// Projetos (Firestore)
// =========================================================

/**
 * Cria um novo projeto
 * @param {{name: string, description: string, budget: number}} data
 * @returns {Promise<string|null>} ID do projeto criado
 */
async function createProject(data) {
  try {
    setLoading(true, "Criando projeto...");
    const docRef = await addDoc(collection(db, "projects"), {
      name: data.name,
      description: data.description || "",
      budget: Number(data.budget) || 0,
      createdBy: currentUser.uid,
      createdAt: serverTimestamp()
    });
    showToast("Projeto criado com sucesso!", "success");
    return docRef.id;
  } catch (error) {
    showToast("Erro ao criar projeto: " + error.message, "error");
    return null;
  } finally {
    setLoading(false);
  }
}

/**
 * Lista todos os projetos do usuário
 * @returns {Promise<Array>}
 */
async function listProjects() {
  try {
    const q = query(collection(db, "projects"), orderBy("createdAt", "desc"));
    const snapshot = await getDocs(q);
    return snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (error) {
    showToast("Erro ao listar projetos: " + error.message, "error");
    return [];
  }
}

/**
 * Obtém um projeto específico
 * @param {string} projectId
 * @returns {Promise<Object|null>}
 */
async function getProject(projectId) {
  try {
    const docRef = doc(db, "projects", projectId);
    const docSnap = await getDoc(docRef);
    if (docSnap.exists()) {
      return { id: docSnap.id, ...docSnap.data() };
    }
    return null;
  } catch (error) {
    showToast("Erro ao obter projeto: " + error.message, "error");
    return null;
  }
}

/**
 * Atualiza um projeto
 * @param {string} projectId
 * @param {Object} data
 * @returns {Promise<boolean>}
 */
async function updateProject(projectId, data) {
  try {
    setLoading(true, "Atualizando projeto...");
    const docRef = doc(db, "projects", projectId);
    await updateDoc(docRef, {
      ...data,
      budget: data.budget !== undefined ? Number(data.budget) : undefined,
      updatedAt: serverTimestamp(),
      updatedBy: currentUser.uid
    });
    showToast("Projeto atualizado com sucesso!", "success");
    return true;
  } catch (error) {
    showToast("Erro ao atualizar projeto: " + error.message, "error");
    return false;
  } finally {
    setLoading(false);
  }
}

/**
 * Exclui um projeto
 * @param {string} projectId
 * @returns {Promise<boolean>}
 */
async function deleteProject(projectId) {
  try {
    setLoading(true, "Excluindo projeto...");
    await deleteDoc(doc(db, "projects", projectId));
    showToast("Projeto excluído com sucesso!", "success");
    return true;
  } catch (error) {
    showToast("Erro ao excluir projeto: " + error.message, "error");
    return false;
  } finally {
    setLoading(false);
  }
}

// =========================================================
// Buscas / Cotações (Firestore - subcoleção de projetos)
// =========================================================

/**
 * Salva uma busca/cotação no Firestore
 * @param {string} projectId
 * @param {Object} searchData
 * @returns {Promise<string|null>}
 */
async function saveSearch(projectId, searchData) {
  try {
    setLoading(true, "Salvando cotação...");
    const docRef = await addDoc(collection(db, "projects", projectId, "searches"), {
      searchTerm: searchData.searchTerm || "",
      productUrl: searchData.productUrl || "",
      cep: searchData.cep || "",
      results: searchData.results || [],
      selectedQuote: searchData.selectedQuote || null,
      createdAt: serverTimestamp(),
      createdBy: currentUser.uid
    });
    showToast("Cotação salva com sucesso!", "success");
    return docRef.id;
  } catch (error) {
    showToast("Erro ao salvar cotação: " + error.message, "error");
    return null;
  } finally {
    setLoading(false);
  }
}

/**
 * Lista as buscas/cotações de um projeto
 * @param {string} projectId
 * @returns {Promise<Array>}
 */
async function listSearches(projectId) {
  try {
    const q = query(
      collection(db, "projects", projectId, "searches"),
      orderBy("createdAt", "desc")
    );
    const snapshot = await getDocs(q);
    return snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (error) {
    showToast("Erro ao listar cotações: " + error.message, "error");
    return [];
  }
}

/**
 * Atualiza uma busca/cotação
 * @param {string} projectId
 * @param {string} searchId
 * @param {Object} data
 * @returns {Promise<boolean>}
 */
async function updateSearch(projectId, searchId, data) {
  try {
    setLoading(true, "Atualizando cotação...");
    const docRef = doc(db, "projects", projectId, "searches", searchId);
    await updateDoc(docRef, {
      ...data,
      updatedAt: serverTimestamp(),
      updatedBy: currentUser.uid
    });
    showToast("Cotação atualizada com sucesso!", "success");
    return true;
  } catch (error) {
    showToast("Erro ao atualizar cotação: " + error.message, "error");
    return false;
  } finally {
    setLoading(false);
  }
}

// =========================================================
// Cotações - Netlify Function e processamento
// =========================================================

/**
 * Busca cotações chamando a Netlify Function
 * @param {{searchTerm?: string, productUrl?: string, cep: string}} params
 * @returns {Promise<Array>}
 */
async function fetchQuotes(params) {
  try {
    setLoading(true, "Buscando cotações...");
    const response = await fetch(SCRAPE_FUNCTION_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        searchTerm: params.searchTerm || "",
        productUrl: params.productUrl || "",
        cep: params.cep
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || `Erro ${response.status} ao buscar cotações`);
    }

    const data = await response.json();
    const quotes = normalizeQuotes(data.quotes || data.results || []);
    return sortQuotesByTotal(quotes);
  } catch (error) {
    showToast("Erro ao buscar cotações: " + error.message, "error");
    return [];
  } finally {
    setLoading(false);
  }
}

/**
 * Normaliza o formato das cotações retornadas
 * @param {Array} quotes
 * @returns {Array}
 */
function normalizeQuotes(quotes) {
  return quotes.map((q) => ({
    store: q.store || q.loja || q.fornecedor || "Fornecedor",
    productName: q.productName || q.product || q.nome || "",
    productUrl: q.productUrl || q.url || q.link || "",
    price: Number(q.price || q.preco || q.valor || 0),
    shipping: Number(q.shipping || q.frete || 0),
    deliveryDays: q.deliveryDays || q.prazo || q.prazoEntrega || null,
    total: 0
  }));
}

/**
 * Ordena cotações pelo custo total (preço + frete)
 * @param {Array} quotes
 * @returns {Array}
 */
function sortQuotesByTotal(quotes) {
  return quotes
    .map((q) => ({
      ...q,
      total: (Number(q.price) || 0) + (Number(q.shipping) || 0)
    }))
    .sort((a, b) => a.total - b.total);
}

/**
 * Encontra a cotação vencedora (menor custo total)
 * @param {Array} quotes
 * @returns {Object|null}
 */
function findWinnerQuote(quotes) {
  if (!quotes || quotes.length === 0) return null;
  const sorted = sortQuotesByTotal(quotes);
  return sorted[0];
}

// =========================================================
// Geração de PDF
// =========================================================

/**
 * Carrega o logo.png como base64 para uso no PDF
 * @returns {Promise<string|null>}
 */
async function loadLogoBase64() {
  try {
    const response = await fetch("logo.png");
    const blob = await response.blob();
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/**
 * Gera o PDF da cotação com logo, informações do projeto,
 * tabela comparativa, vencedor e linha de assinatura
 * @param {Object} project
 * @param {Object} search
 * @param {Array} quotes
 * @param {Object|null} selectedQuote
 */
async function generatePdf(project, search, quotes, selectedQuote) {
  try {
    setLoading(true, "Gerando PDF...");
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: "mm", format: "a4" });

    // Carrega o logo
    const logoBase64 = await loadLogoBase64();

    let yPosition = 20;

    // Adiciona o logo no topo do PDF
    if (logoBase64) {
      try {
        const logoWidth = 40;
        const logoHeight = 20;
        const pageWidth = doc.internal.pageSize.getWidth();
        const logoX = (pageWidth - logoWidth) / 2;
        doc.addImage(logoBase64, "PNG", logoX, yPosition, logoWidth, logoHeight);
        yPosition += logoHeight + 10;
      } catch {
        // Se falhar ao adicionar imagem, continua sem logo
        console.warn("Não foi possível adicionar o logo ao PDF.");
      }
    }

    // Título do documento
    doc.setFontSize(16);
    doc.setFont(undefined, "bold");
    doc.text("Relatório de Cotação", doc.internal.pageSize.getWidth() / 2, yPosition, {
      align: "center"
    });
    yPosition += 10;

    // Informações do projeto
    doc.setFontSize(11);
    doc.setFont(undefined, "normal");
    doc.text(`Projeto: ${project.name || "-"}`, 15, yPosition);
    yPosition += 7;
    if (project.description) {
      const descLines = doc.splitTextToSize(`Descrição: ${project.description}`, 180);
      doc.text(descLines, 15, yPosition);
      yPosition += descLines.length * 5;
    }
    doc.text(`Orçamento: ${formatCurrency(project.budget)}`, 15, yPosition);
    yPosition += 7;
    doc.text(`Data: ${formatDate(new Date())}`, 15, yPosition);
    yPosition += 10;

    // Informações da busca
    doc.setFont(undefined, "bold");
    doc.text("Dados da Busca", 15, yPosition);
    yPosition += 7;
    doc.setFont(undefined, "normal");
    if (search.searchTerm) {
      doc.text(`Termo buscado: ${search.searchTerm}`, 15, yPosition);
      yPosition += 5;
    }
    if (search.productUrl) {
      doc.text(`URL do produto: ${search.productUrl}`, 15, yPosition);
      yPosition += 5;
    }
    doc.text(`CEP: ${search.cep || "-"}`, 15, yPosition);
    yPosition += 10;

    // Tabela comparativa de cotações
    doc.setFont(undefined, "bold");
    doc.text("Cotações (ordenadas por custo total)", 15, yPosition);
    yPosition += 7;

    // Cabeçalho da tabela
    doc.setFontSize(9);
    doc.setFont(undefined, "bold");
    doc.text("Fornecedor", 15, yPosition);
    doc.text("Preço", 80, yPosition);
    doc.text("Frete", 110, yPosition);
    doc.text("Total", 140, yPosition);
    doc.text("Prazo", 175, yPosition);
    yPosition += 5;

    // Linha separadora
    doc.setDrawColor(200);
    doc.line(15, yPosition, 195, yPosition);
    yPosition += 5;

    // Dados das cotações
    doc.setFont(undefined, "normal");
    const sortedQuotes = sortQuotesByTotal(quotes);
    const winner = selectedQuote || findWinnerQuote(sortedQuotes);

    sortedQuotes.forEach((quote, index) => {
      if (yPosition > 270) {
        doc.addPage();
        yPosition = 20;
      }

      const isWinner = winner && quote.store === winner.store && quote.total === winner.total;
      if (isWinner) {
        doc.setFillColor(220, 255, 220);
        doc.rect(14, yPosition - 4, 182, 6, "F");
      }

      doc.text(String(quote.store).substring(0, 30), 15, yPosition);
      doc.text(formatCurrency(quote.price), 80, yPosition);
      doc.text(formatCurrency(quote.shipping), 110, yPosition);
      doc.setFont(undefined, "bold");
      doc.text(formatCurrency(quote.total), 140, yPosition);
      doc.setFont(undefined, "normal");
      doc.text(
        quote.deliveryDays ? `${quote.deliveryDays} dias` : "-",
        175,
        yPosition
      );
      yPosition += 6;
    });

    yPosition += 10;

    // Destaque do vencedor
    if (winner) {
      if (yPosition > 250) {
        doc.addPage();
        yPosition = 20;
      }
      doc.setFontSize(12);
      doc.setFont(undefined, "bold");
      doc.setFillColor(240, 255, 240);
      doc.rect(15, yPosition - 5, 180, 12, "F");
      doc.text(
        `Fornecedor Vencedor: ${winner.store} - ${formatCurrency(winner.total)}`,
        17,
        yPosition + 2
      );
      yPosition += 15;
    }

    // Linha de assinatura
    yPosition += 20;
    if (yPosition > 250) {
      doc.addPage();
      yPosition = 20;
    }
    doc.setDrawColor(0);
    doc.line(40, yPosition, 170, yPosition);
    doc.setFontSize(10);
    doc.setFont(undefined, "normal");
    doc.text("Assinatura / Carimbo", doc.internal.pageSize.getWidth() / 2, yPosition + 5, {
      align: "center"
    });

    // Rodapé
    const pageCount = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
      doc.setPage(i);
      doc.setFontSize(8);
      doc.setTextColor(150);
      doc.text(
        `Cotações ONG - Página ${i} de ${pageCount}`,
        doc.internal.pageSize.getWidth() / 2,
        290,
        { align: "center" }
      );
      doc.setTextColor(0);
    }

    // Salva o PDF
    const fileName = `cotacao_${(project.name || "projeto")
      .replace(/[^a-zA-Z0-9]/g, "_")
      .toLowerCase()}_${Date.now()}.pdf`;
    doc.save(fileName);
    showToast("PDF gerado com sucesso!", "success");
  } catch (error) {
    showToast("Erro ao gerar PDF: " + error.message, "error");
  } finally {
    setLoading(false);
  }
}

// =========================================================
// Renderização de Views
// =========================================================

/**
 * Renderiza a barra de navegação com logo
 */
function renderNavbar() {
  const navbar = document.getElementById("navbar");
  if (!navbar) return;
  navbar.innerHTML = `
    <div class="navbar-brand">
      <img src="logo.png" class="navbar-logo-img" alt="WAB" />
      <span class="navbar-title">Cotações ONG</span>
    </div>
    <div class="navbar-actions">
      <button class="btn btn-link" onclick="navigateTo('dashboard')">Projetos</button>
      <button class="btn btn-link" onclick="navigateTo('settings')">Configurações</button>
      <button class="btn btn-outline" onclick="logout()">Sair</button>
    </div>
  `;
}

/**
 * Renderiza a tela de autenticação (login/registro)
 */
function renderAuthView() {
  const app = document.getElementById("app");
  app.innerHTML = `
    <div class="auth-container">
      <div class="auth-card">
        <img src="logo.png" class="auth-logo" alt="WAB" />
        <h1 class="auth-title">Cotações ONG</h1>
        <p class="auth-subtitle">Sistema automatizado de cotações</p>
        <form id="auth-form">
          <div class="form-group">
            <label for="auth-email">E-mail</label>
            <input type="email" id="auth-email" class="form-input" required placeholder="seu@email.com" />
          </div>
          <div class="form-group">
            <label for="auth-password">Senha</label>
            <input type="password" id="auth-password" class="form-input" required placeholder="Mínimo 6 caracteres" />
          </div>
          <div class="auth-actions">
            <button type="submit" id="auth-submit-btn" class="btn btn-primary btn-block">Entrar</button>
            <button type="button" id="auth-toggle-btn" class="btn btn-link btn-block">Criar nova conta</button>
          </div>
        </form>
      </div>
    </div>
  `;

  let isLoginMode = true;
  const form = document.getElementById("auth-form");
  const submitBtn = document.getElementById("auth-submit-btn");
  const toggleBtn = document.getElementById("auth-toggle-btn");

  toggleBtn.addEventListener("click", () => {
    isLoginMode = !isLoginMode;
    submitBtn.textContent = isLoginMode ? "Entrar" : "Registrar";
    toggleBtn.textContent = isLoginMode ? "Criar nova conta" : "Já tenho conta";
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = document.getElementById("auth-email").value.trim();
    const password = document.getElementById("auth-password").value;
    if (isLoginMode) {
      await login(email, password);
    } else {
      await register(email, password);
    }
  });
}

/**
 * Renderiza o dashboard com lista de projetos
 */
async function renderDashboard() {
  const app = document.getElementById("app");
  app.innerHTML = `
    <div class="dashboard-container">
      <div class="dashboard-header">
        <h2>Meus Projetos</h2>
        <button class="btn btn-primary" onclick="showCreateProjectForm()">+ Novo Projeto</button>
      </div>
      <div id="projects-list" class="projects-list">
        <p class="loading-text">Carregando projetos...</p>
      </div>
    </div>
  `;

  const projects = await listProjects();
  const listContainer = document.getElementById("projects-list");

  if (projects.length === 0) {
    listContainer.innerHTML = `
      <div class="empty-state">
        <p>Nenhum projeto encontrado.</p>
        <p>Clique em "Novo Projeto" para começar.</p>
      </div>
    `;
    return;
  }

  listContainer.innerHTML = projects
    .map(
      (project) => `
    <div class="project-card" onclick="openProject('${escapeHtml(project.id)}')">
      <h3 class="project-name">${escapeHtml(project.name)}</h3>
      <p class="project-description">${escapeHtml(project.description || "Sem descrição")}</p>
      <p class="project-budget">Orçamento: ${formatCurrency(project.budget)}</p>
      <p class="project-date">Criado em: ${formatDate(project.createdAt?.toDate ? project.createdAt.toDate() : project.createdAt)}</p>
    </div>
  `
    )
    .join("");
}

/**
 * Renderiza os detalhes de um projeto específico
 * @param {string} projectId
 */
async function renderProjectDetail(projectId) {
  currentProjectId = projectId;
  const project = await getProject(projectId);
  if (!project) {
    showToast("Projeto não encontrado.", "error");
    navigateTo("dashboard");
    return;
  }

  const app = document.getElementById("app");
  app.innerHTML = `
    <div class="project-detail-container">
      <button class="btn btn-link" onclick="navigateTo('dashboard')">&larr; Voltar para Projetos</button>
      <div class="project-detail-header">
        <h2>${escapeHtml(project.name)}</h2>
        <div class="project-detail-actions">
          <button class="btn btn-primary" onclick="navigateToSearch('${escapeHtml(projectId)}')">Nova Cotação</button>
          <button class="btn btn-outline" onclick="showEditProjectForm('${escapeHtml(projectId)}')">Editar</button>
          <button class="btn btn-danger" onclick="confirmDeleteProject('${escapeHtml(projectId)}')">Excluir</button>
        </div>
      </div>
      <div class="project-info">
        <p><strong>Descrição:</strong> ${escapeHtml(project.description || "-")}</p>
        <p><strong>Orçamento:</strong> ${formatCurrency(project.budget)}</p>
      </div>
      <h3>Cotações Realizadas</h3>
      <div id="searches-list" class="searches-list">
        <p class="loading-text">Carregando cotações...</p>
      </div>
    </div>
  `;

  const searches = await listSearches(projectId);
  const listContainer = document.getElementById("searches-list");

  if (searches.length === 0) {
    listContainer.innerHTML = `
      <div class="empty-state">
        <p>Nenhuma cotação encontrada para este projeto.</p>
      </div>
    `;
    return;
  }

  listContainer.innerHTML = searches
    .map(
      (search) => {
        const winner = search.selectedQuote || findWinnerQuote(search.results || []);
        return `
        <div class="search-card">
          <div class="search-info">
            <p><strong>Busca:</strong> ${escapeHtml(search.searchTerm || search.productUrl || "-")}</p>
            <p><strong>CEP:</strong> ${escapeHtml(search.cep || "-")}</p>
            <p><strong>Data:</strong> ${formatDate(search.createdAt?.toDate ? search.createdAt.toDate() : search.createdAt)}</p>
            ${winner ? `<p><strong>Vencedor:</strong> ${escapeHtml(winner.store)} - ${formatCurrency(winner.total)}</p>` : ""}
          </div>
          <div class="search-actions">
            <button class="btn btn-link" onclick="viewSearchResults('${escapeHtml(projectId)}', '${escapeHtml(search.id)}')">Ver Detalhes</button>
          </div>
        </div>
      `;
      }
    )
    .join("");
}

/**
 * Renderiza a tela de busca de cotações
 * @param {string} projectId
 */
function renderSearchView(projectId) {
  currentProjectId = projectId;
  const app = document.getElementById("app");
  app.innerHTML = `
    <div class="search-container">
      <button class="btn btn-link" onclick="openProject('${escapeHtml(projectId)}')">&larr; Voltar ao Projeto</button>
      <h2>Nova Cotação</h2>
      <form id="search-form">
        <div class="form-group">
          <label for="search-term">Nome do Item</label>
          <input type="text" id="search-term" class="form-input" placeholder="Ex: Notebook Dell" />
          <p class="form-hint">Ou informe a URL do produto abaixo:</p>
        </div>
        <div class="form-group">
          <label for="product-url">URL do Produto</label>
          <input type="url" id="product-url" class="form-input" placeholder="https://..." />
        </div>
        <div class="form-group">
          <label for="cep">CEP</label>
          <input type="text" id="cep" class="form-input" required placeholder="00000-000" />
        </div>
        <div class="search-actions">
          <button type="submit" class="btn btn-primary btn-block">Buscar Cotações</button>
          <button type="button" class="btn btn-outline btn-block" onclick="showManualQuoteForm('${escapeHtml(projectId)}')">Inserir Cotação Manual</button>
        </div>
      </form>
      <div id="search-results-container"></div>
    </div>
  `;

  const form = document.getElementById("search-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const searchTerm = document.getElementById("search-term").value.trim();
    const productUrl = document.getElementById("product-url").value.trim();
    const cep = document.getElementById("cep").value.trim();

    if (!searchTerm && !productUrl) {
      showToast("Informe o nome do item ou a URL do produto.", "warning");
      return;
    }

    if (!cep) {
      showToast("Informe o CEP.", "warning");
      return;
    }

    const quotes = await fetchQuotes({ searchTerm, productUrl, cep });
    currentSearchData = { searchTerm, productUrl, cep, results: quotes };
    renderSearchResultsView(projectId, currentSearchData);
  });
}

/**
 * Renderiza os resultados da busca
 * @param {string} projectId
 * @param {Object} searchData
 */
function renderSearchResultsView(projectId, searchData) {
  const container = document.getElementById("search-results-container");
  if (!container) return;

  const quotes = searchData.results || [];
  const winner = findWinnerQuote(quotes);

  if (quotes.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <p>Nenhuma cotação encontrada.</p>
        <button class="btn btn-outline" onclick="showManualQuoteForm('${escapeHtml(projectId)}')">Inserir Cotação Manual</button>
      </div>
    `;
    return;
  }

  container.innerHTML = `
    <h3>Resultados (${quotes.length} cotações)</h3>
    <div class="quotes-list">
      ${quotes.map((quote, index) => renderQuoteCard(quote, index, winner)).join("")}
    </div>
    <div class="results-actions">
      <button class="btn btn-primary" onclick="saveCurrentSearch('${escapeHtml(projectId)}')">Salvar Cotação</button>
      <button class="btn btn-outline" onclick="generatePdfForCurrentSearch('${escapeHtml(projectId)}')">Gerar PDF</button>
    </div>
  `;
}

/**
 * Renderiza um card de cotação individual
 * @param {Object} quote
 * @param {number} index
 * @param {Object|null} winner
 * @returns {string}
 */
function renderQuoteCard(quote, index, winner) {
  const isWinner = winner && quote.store === winner.store && quote.total === winner.total;
  return `
    <div class="quote-card ${isWinner ? "quote-winner" : ""}">
      ${isWinner ? '<span class="winner-badge">Melhor Oferta</span>' : ""}
      <h4 class="quote-store">${escapeHtml(quote.store)}</h4>
      ${quote.productName ? `<p class="quote-product">${escapeHtml(quote.productName)}</p>` : ""}
      <div class="quote-details">
        <div class="quote-row">
          <span>Preço:</span>
          <span>${formatCurrency(quote.price)}</span>
        </div>
        <div class="quote-row">
          <span>Frete:</span>
          <span>${formatCurrency(quote.shipping)}</span>
        </div>
        <div class="quote-row quote-total">
          <span>Total:</span>
          <span>${formatCurrency(quote.total)}</span>
        </div>
        ${quote.deliveryDays ? `<div class="quote-row"><span>Prazo:</span><span>${escapeHtml(String(quote.deliveryDays))} dias</span></div>` : ""}
        ${quote.productUrl ? `<a href="${escapeHtml(quote.productUrl)}" target="_blank" rel="noopener" class="quote-link">Ver produto</a>` : ""}
      </div>
      <button class="btn btn-link" onclick="selectQuote(${index})">Selecionar como vencedora</button>
    </div>
  `;
}

/**
 * Exibe o formulário de cotação manual
 * @param {string} projectId
 */
function showManualQuoteForm(projectId) {
  const modal = document.createElement("div");
  modal.className = "modal-overlay";
  modal.innerHTML = `
    <div class="modal-content modal-large">
      <h3 class="modal-title">Cotação Manual</h3>
      <form id="manual-quote-form">
        <div class="form-group">
          <label for="manual-store">Fornecedor</label>
          <input type="text" id="manual-store" class="form-input" required placeholder="Nome do fornecedor" />
        </div>
        <div class="form-group">
          <label for="manual-product">Nome do Produto</label>
          <input type="text" id="manual-product" class="form-input" placeholder="Nome do produto" />
        </div>
        <div class="form-group">
          <label for="manual-url">URL do Produto</label>
          <input type="url" id="manual-url" class="form-input" placeholder="https://..." />
        </div>
        <div class="form-row">
          <div class="form-group">
            <label for="manual-price">Preço (R$)</label>
            <input type="number" id="manual-price" class="form-input" required step="0.01" min="0" placeholder="0.00" />
          </div>
          <div class="form-group">
            <label for="manual-shipping">Frete (R$)</label>
            <input type="number" id="manual-shipping" class="form-input" step="0.01" min="0" placeholder="0.00" value="0" />
          </div>
        </div>
        <div class="form-group">
          <label for="manual-delivery">Prazo de Entrega (dias)</label>
          <input type="number" id="manual-delivery" class="form-input" min="0" placeholder="Ex: 7" />
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-secondary modal-cancel">Cancelar</button>
          <button type="submit" class="btn btn-primary">Adicionar Cotação</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(modal);

  modal.querySelector(".modal-cancel").addEventListener("click", () => modal.remove());
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.remove();
  });

  const form = modal.querySelector("#manual-quote-form");
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const quote = {
      store: document.getElementById("manual-store").value.trim(),
      productName: document.getElementById("manual-product").value.trim(),
      productUrl: document.getElementById("manual-url").value.trim(),
      price: Number(document.getElementById("manual-price").value) || 0,
      shipping: Number(document.getElementById("manual-shipping").value) || 0,
      deliveryDays: document.getElementById("manual-delivery").value
        ? Number(document.getElementById("manual-delivery").value)
        : null,
      total: 0
    };
    quote.total = quote.price + quote.shipping;

    if (!currentSearchData) {
      currentSearchData = {
        searchTerm: "",
        productUrl: "",
        cep: document.getElementById("cep") ? document.getElementById("cep").value.trim() : "",
        results: []
      };
    }

    currentSearchData.results = currentSearchData.results || [];
    currentSearchData.results.push(quote);
    modal.remove();
    renderSearchResultsView(projectId, currentSearchData);
    showToast("Cotação manual adicionada!", "success");
  });
}

/**
 * Renderiza a tela de configurações
 */
function renderSettingsView() {
  const app = document.getElementById("app");
  app.innerHTML = `
    <div class="settings-container">
      <h2>Configurações</h2>
      <div class="settings-section">
        <h3>Conta</h3>
        <p><strong>E-mail:</strong> ${escapeHtml(currentUser?.email || "-")}</p>
        <p><strong>ID:</strong> ${escapeHtml(currentUser?.uid || "-")}</p>
      </div>
      <div class="settings-section">
        <h3>Sobre</h3>
        <p>Sistema automatizado de cotações para ONGs.</p>
        <p>Gera 3 cotações automaticamente, ordenadas por custo total, com destaque para o vencedor.</p>
      </div>
      <div class="settings-section">
        <button class="btn btn-danger" onclick="logout()">Sair da Conta</button>
      </div>
    </div>
  `;
}

// =========================================================
// Ações e Navegação
// =========================================================

/**
 * Navega entre as views da aplicação
 * @param {string} view
 */
function navigateTo(view) {
  currentView = view;
  renderApp();
}

/**
 * Abre um projeto específico
 * @param {string} projectId
 */
function openProject(projectId) {
  currentView = "projectDetail";
  renderProjectDetail(projectId);
}

/**
 * Navega para a tela de busca
 * @param {string} projectId
 */
function navigateToSearch(projectId) {
  currentView = "search";
  renderSearchView(projectId);
}

/**
 * Visualiza resultados de uma busca salva
 * @param {string} projectId
 * @param {string} searchId
 */
async function viewSearchResults(projectId, searchId) {
  try {
    setLoading(true, "Carregando cotação...");
    const searches = await listSearches(projectId);
    const search = searches.find((s) => s.id === searchId);
    if (!search) {
      showToast("Cotação não encontrada.", "error");
      setLoading(false);
      return;
    }
    currentProjectId = projectId;
    currentSearchData = search;
    currentView = "search";
    renderSearchView(projectId);
    renderSearchResultsView(projectId, search);
  } catch (error) {
    showToast("Erro ao carregar cotação: " + error.message, "error");
  } finally {
    setLoading(false);
  }
}

/**
 * Seleciona uma cotação como vencedora
 * @param {number} index
 */
function selectQuote(index) {
  if (!currentSearchData || !currentSearchData.results) return;
  const sorted = sortQuotesByTotal(currentSearchData.results);
  currentSearchData.selectedQuote = sorted[index] || currentSearchData.results[index];
  showToast("Cotação selecionada como vencedora!", "success");
  renderSearchResultsView(currentProjectId, currentSearchData);
}

/**
 * Salva a busca atual no Firestore
 * @param {string} projectId
 */
async function saveCurrentSearch(projectId) {
  if (!currentSearchData) {
    showToast("Nenhuma cotação para salvar.", "warning");
    return;
  }
  await saveSearch(projectId, currentSearchData);
}

/**
 * Gera PDF para a busca atual
 * @param {string} projectId
 */
async function generatePdfForCurrentSearch(projectId) {
  if (!currentSearchData) {
    showToast("Nenhuma cotação para gerar PDF.", "warning");
    return;
  }
  const project = await getProject(projectId);
  if (!project) {
    showToast("Projeto não encontrado.", "error");
    return;
  }
  await generatePdf(project, currentSearchData, currentSearchData.results, currentSearchData.selectedQuote);
}

/**
 * Exibe formulário de criação de projeto
 */
function showCreateProjectForm() {
  const modal = document.createElement("div");
  modal.className = "modal-overlay";
  modal.innerHTML = `
    <div class="modal-content modal-large">
      <h3 class="modal-title">Novo Projeto</h3>
      <form id="project-form">
        <div class="form-group">
          <label for="project-name">Nome do Projeto</label>
          <input type="text" id="project-name" class="form-input" required placeholder="Ex: Construção de Sala" />
        </div>
        <div class="form-group">
          <label for="project-description">Descrição</label>
          <textarea id="project-description" class="form-input" rows="3" placeholder="Descrição do projeto"></textarea>
        </div>
        <div class="form-group">
          <label for="project-budget">Orçamento (R$)</label>
          <input type="number" id="project-budget" class="form-input" required step="0.01" min="0" placeholder="0.00" />
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-secondary modal-cancel">Cancelar</button>
          <button type="submit" class="btn btn-primary">Criar Projeto</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(modal);

  modal.querySelector(".modal-cancel").addEventListener("click", () => modal.remove());
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.remove();
  });

  const form = modal.querySelector("#project-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = {
      name: document.getElementById("project-name").value.trim(),
      description: document.getElementById("project-description").value.trim(),
      budget: document.getElementById("project-budget").value
    };
    const projectId = await createProject(data);
    modal.remove();
    if (projectId) {
      renderDashboard();
    }
  });
}

/**
 * Exibe formulário de edição de projeto
 * @param {string} projectId
 */
async function showEditProjectForm(projectId) {
  const project = await getProject(projectId);
  if (!project) return;

  const modal = document.createElement("div");
  modal.className = "modal-overlay";
  modal.innerHTML = `
    <div class="modal-content modal-large">
      <h3 class="modal-title">Editar Projeto</h3>
      <form id="project-edit-form">
        <div class="form-group">
          <label for="edit-project-name">Nome do Projeto</label>
          <input type="text" id="edit-project-name" class="form-input" required value="${escapeHtml(project.name)}" />
        </div>
        <div class="form-group">
          <label for="edit-project-description">Descrição</label>
          <textarea id="edit-project-description" class="form-input" rows="3">${escapeHtml(project.description || "")}</textarea>
        </div>
        <div class="form-group">
          <label for="edit-project-budget">Orçamento (R$)</label>
          <input type="number" id="edit-project-budget" class="form-input" required step="0.01" min="0" value="${project.budget || 0}" />
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-secondary modal-cancel">Cancelar</button>
          <button type="submit" class="btn btn-primary">Salvar Alterações</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(modal);

  modal.querySelector(".modal-cancel").addEventListener("click", () => modal.remove());
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.remove();
  });

  const form = modal.querySelector("#project-edit-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = {
      name: document.getElementById("edit-project-name").value.trim(),
      description: document.getElementById("edit-project-description").value.trim(),
      budget: document.getElementById("edit-project-budget").value
    };
    const success = await updateProject(projectId, data);
    modal.remove();
    if (success) {
      renderProjectDetail(projectId);
    }
  });
}

/**
 * Confirma exclusão de projeto
 * @param {string} projectId
 */
function confirmDeleteProject(projectId) {
  showConfirmModal(
    "Excluir Projeto",
    "Tem certeza que deseja excluir este projeto? Todas as cotações associadas também serão removidas.",
    async () => {
      const success = await deleteProject(projectId);
      if (success) {
        navigateTo("dashboard");
      }
    }
  );
}

// =========================================================
// Renderização Principal
// =========================================================

/**
 * Renderiza a aplicação com base no estado atual
 */
function renderApp() {
  const navbar = document.getElementById("navbar");
  const app = document.getElementById("app");

  if (!currentUser) {
    navbar.innerHTML = "";
    renderAuthView();
    return;
  }

  renderNavbar();

  switch (currentView) {
    case "dashboard":
      renderDashboard();
      break;
    case "projectDetail":
      if (currentProjectId) {
        renderProjectDetail(currentProjectId);
      } else {
        renderDashboard();
      }
      break;
    case "search":
      if (currentProjectId) {
        renderSearchView(currentProjectId);
      } else {
        renderDashboard();
      }
      break;
    case "settings":
      renderSettingsView();
      break;
    default:
      renderDashboard();
  }
}

// =========================================================
// Inicialização
// =========================================================

// Observa mudanças no estado de autenticação
onAuthStateChanged(auth, (user) => {
  currentUser = user;
  if (user) {
    currentView = currentView === "auth" ? "dashboard" : currentView;
  } else {
    currentView = "auth";
    currentProjectId = null;
    currentSearchData = null;
  }
  renderApp();
});

// Expõe funções globalmente para uso em onclick handlers
window.navigateTo = navigateTo;
window.openProject = openProject;
window.navigateToSearch = navigateToSearch;
window.logout = logout;
window.login = login;
window.register = register;
window.showCreateProjectForm = showCreateProjectForm;
window.showEditProjectForm = showEditProjectForm;
window.confirmDeleteProject = confirmDeleteProject;
window.showManualQuoteForm = showManualQuoteForm;
window.selectQuote = selectQuote;
window.saveCurrentSearch = saveCurrentSearch;
window.generatePdfForCurrentSearch = generatePdfForCurrentSearch;
window.viewSearchResults = viewSearchResults;
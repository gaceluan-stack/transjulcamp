// ==========================================================================
// Transjulcamp Frontend Application Logic
// ==========================================================================

const API_BASE = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
    ? "/api"
    : "https://transjulcamp.onrender.com/api";

// App State
let state = {
    contacts: [],
    drivers: [],
    machinery: [],
    products: [],
    guides: [],
    invoices: [],
    kpis: {},
    chartsData: {},
    activeTab: "dashboard",
    activeSubTab: {
        approvals: "invoices-approval",
        catalogues: "crud-products"
    },
    ocrQueue: [],
    ocrActiveId: null,
    // Grid State
    gridGuides: [],
    groupBy: "",
    expandedGroups: {},
    gridSort: { col: "guide_date", dir: "desc" },
    filters: { client: "", plate: "", status: "" },
    dashboardFilters: { client: "", plate: "", driver: "", project: "" },
    dashboardSearchQuery: "",
    schedules: [],
    planningYear: 2026,
    planningMonth: 6, // July (0-indexed)
    planningSelectedDateStr: "2026-07-03"
};

// Chart instances
let charts = {
    revenue: null,
    productivity: null
};

// Initialize Application
document.addEventListener("DOMContentLoaded", () => {
    // Current date in banner
    const dateBanner = document.getElementById("dashboard-date");
    if (dateBanner) {
        dateBanner.textContent = new Date().toLocaleDateString('es-EC', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    }

    // Set up Global Search Bar filter for Dashboard
    const searchInput = document.querySelector(".header-search input");
    if (searchInput) {
        searchInput.addEventListener("input", (e) => {
            state.dashboardSearchQuery = e.target.value;
            if (state.activeTab === "dashboard") {
                renderDashboardData();
            }
        });
    }

    // Set up tabs and routing
    initTabs();
    initThemeToggle();
    
    // Set up Login Form Handler
    const formLogin = document.getElementById("form-login");
    formLogin.addEventListener("submit", async (e) => {
        e.preventDefault();
        const usernameInput = document.getElementById("login-username").value;
        const passwordInput = document.getElementById("login-password").value;
        const errorMsg = document.getElementById("login-error");

        errorMsg.style.display = "none";

        try {
            const res = await fetchAPI("/login", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ username: usernameInput, password: passwordInput })
            });

            // Save session
            sessionStorage.setItem("token", res.token);
            sessionStorage.setItem("username", res.username);
            sessionStorage.setItem("role", res.role);

            // Verify session and load app
            checkAuth();
            await refreshAllData();
            
            // Go to dashboard
            switchTab("dashboard");
            formLogin.reset();

        } catch (err) {
            errorMsg.textContent = "Usuario o contraseña incorrectos.";
            errorMsg.style.display = "flex";
        }
    });

    // Set up Logout Handler
    document.getElementById("btn-logout").addEventListener("click", () => {
        sessionStorage.clear();
        checkAuth();
        switchTab("dashboard");
    });

    // Always initialize DOM event listener modules unconditionally on DOM load
    initDashboard();
    initOCRModule();
    initReportsGrid();
    initApprovalsModule();
    initCollectionsModule();
    initCataloguesModule();
    initPlanningModule();

    // Check session on load
    checkAuth();
    if (sessionStorage.getItem("token")) {
        refreshAllData().then(() => {
            switchTab("dashboard");
        });
    }
});

// Authentication and RBAC Verification
function checkAuth() {
    const token = sessionStorage.getItem("token");
    const username = sessionStorage.getItem("username");
    const role = sessionStorage.getItem("role");

    const loginContainer = document.getElementById("login-container");
    const appContainer = document.getElementById("app-container-layout");

    if (!token) {
        // Show Login, Hide App
        loginContainer.style.display = "flex";
        appContainer.style.display = "none";
    } else {
        // Hide Login, Show App
        loginContainer.style.display = "none";
        appContainer.style.display = "flex";

        // Update profile in sidebar
        document.getElementById("sidebar-user-name").textContent = username;
        document.getElementById("sidebar-user-role").textContent = role;

        // Apply Role-Based Access Control (RBAC)
        applyRBAC(role);
    }
}

function applyRBAC(role) {
    const btnCollections = document.getElementById("btn-tab-collections");
    const btnApprovals = document.getElementById("btn-tab-approvals");
    const btnCatalogues = document.getElementById("btn-tab-catalogues");

    // Reset visibility
    btnCollections.style.display = "flex";
    btnApprovals.style.display = "flex";
    btnCatalogues.style.display = "flex";

    // Supervisor restrictions
    if (role === "Supervisor") {
        btnCollections.style.display = "none";
        btnCatalogues.style.display = "none";
        if (state.activeTab === "collections" || state.activeTab === "catalogues") {
            switchTab("dashboard");
        }
    }
    // Facturador restrictions
    else if (role === "Facturador") {
        btnCatalogues.style.display = "none";
        if (state.activeTab === "catalogues") {
            switchTab("dashboard");
        }
    }
}

// Refresh all cache from API
async function refreshAllData() {
    if (!sessionStorage.getItem("token")) return;
    try {
        const [contacts, drivers, machinery, products, guides, invoices, kpis, chartsData, schedules] = await Promise.all([
            fetchAPI("/contacts"),
            fetchAPI("/drivers"),
            fetchAPI("/machinery"),
            fetchAPI("/products"),
            fetchAPI("/guides"),
            fetchAPI("/invoices"),
            fetchAPI("/dashboard/kpis"),
            fetchAPI("/dashboard/charts"),
            fetchAPI("/schedules")
        ]);

        state.contacts = contacts;
        state.drivers = drivers;
        state.machinery = machinery;
        state.products = products;
        state.guides = guides;
        state.invoices = invoices;
        state.kpis = kpis;
        state.chartsData = chartsData;
        state.schedules = schedules;
        
        state.gridGuides = [...guides]; // copy for grid filtering/sorting

        // Populate dropdown lists in forms
        populateDropdowns();
        
        // Update Alert Badge (unbilled guides & pending approvals)
        updateAlertBadges();

        // Render planning calendar if current tab is planning
        if (state.activeTab === "planning") {
            renderPlanningCalendar();
        }

    } catch (err) {
        console.error("Error refreshing application data:", err);
    }
}

// --- UTILITIES ---

async function fetchAPI(endpoint, options = {}) {
    const token = sessionStorage.getItem("token");
    if (token) {
        if (!options.headers) options.headers = {};
        options.headers["Authorization"] = `Bearer ${token}`;
    }
    const url = `${API_BASE}${endpoint}`;
    const res = await fetch(url, options);
    if (res.status === 401) {
        sessionStorage.clear();
        checkAuth();
        throw new Error("Sesión expirada. Inicie sesión nuevamente.");
    }
    if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: "Unknown error occurred" }));
        throw new Error(err.detail || res.statusText);
    }
    return res.json();
}

function updateAlertBadges() {
    const unbilledCount = state.guides.filter(g => g.billing_status === 'Pendiente').length;
    const pendingApprovalCount = state.invoices.filter(i => i.approval_status === 'Pendiente').length;
    
    const totalAlerts = unbilledCount + pendingApprovalCount;
    const badge = document.getElementById("alert-badge");
    if (badge) {
        badge.textContent = totalAlerts;
        badge.style.display = totalAlerts > 0 ? "flex" : "none";
    }
}

// Populate dropdown inputs globally
function populateDropdowns() {
    const dropdowns = {
        "ocr-client": state.contacts,
        "ocr-driver": state.drivers,
        "ocr-plate": state.machinery.map(m => ({ id: m.plate_code, name: `${m.plate_code} (${m.type})` })),
        "ocr-product": state.products,
        "filter-client": state.contacts,
        "filter-plate": state.machinery.map(m => ({ id: m.plate_code, name: m.plate_code })),
        "machinery-driver": state.drivers,
        "edit-invoice-client": state.contacts,
        "db-filter-client": state.contacts,
        "db-filter-plate": state.machinery.map(m => ({ id: m.plate_code, name: m.plate_code })),
        "db-filter-driver": state.drivers,
        "schedule-client": state.contacts,
        "schedule-driver": state.drivers,
        "schedule-plate": state.machinery.map(m => ({ id: m.plate_code, name: `${m.plate_code} (${m.type})` }))
    };

    for (const [id, list] of Object.entries(dropdowns)) {
        const el = document.getElementById(id);
        if (!el) continue;
        
        // Preserve first option (empty option)
        const firstOpt = el.options[0];
        el.innerHTML = "";
        if (firstOpt) el.appendChild(firstOpt);
        
        list.forEach(item => {
            const opt = document.createElement("option");
            opt.value = item.id || item.plate_code || item.value;
            opt.textContent = item.name || item.plate_code;
            el.appendChild(opt);
        });
    }

    // Populate unique projects/obras in dashboard filter
    const dbProjectSelect = document.getElementById("db-filter-project");
    if (dbProjectSelect) {
        const uniqueProjects = [...new Set(state.guides.map(g => g.project).filter(Boolean))].sort();
        const firstOpt = dbProjectSelect.options[0];
        dbProjectSelect.innerHTML = "";
        if (firstOpt) dbProjectSelect.appendChild(firstOpt);
        
        uniqueProjects.forEach(p => {
            const opt = document.createElement("option");
            opt.value = p;
            opt.textContent = p;
            dbProjectSelect.appendChild(opt);
        });
    }
}

// --- TAB ROUTING ---

function initTabs() {
    // Main sidebar tabs
    document.querySelectorAll(".sidebar-menu .menu-item").forEach(btn => {
        btn.addEventListener("click", (e) => {
            e.preventDefault();
            const tabName = btn.dataset.tab;
            switchTab(tabName);
        });
    });

    // Subtabs within views (Aprobaciones, Catálogos)
    document.querySelectorAll(".sub-tab-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            const subtabName = btn.dataset.subtab;
            const parentSection = btn.closest(".tab-panel").id;
            const tabKey = parentSection.replace("view-", "");
            
            // Toggle active buttons in current group
            btn.parentNode.querySelectorAll(".sub-tab-btn").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            
            // Toggle sub-tab panels
            document.querySelectorAll(`#${parentSection} .subtab-panel`).forEach(panel => {
                panel.classList.remove("active");
            });
            const activePanel = document.getElementById(`subview-${subtabName}`);
            if (activePanel) activePanel.classList.add("active");
            
            state.activeSubTab[tabKey] = subtabName;
        });
    });
}

function switchTab(tabName) {
    state.activeTab = tabName;
    
    // Update sidebar buttons
    document.querySelectorAll(".sidebar-menu .menu-item").forEach(btn => {
        if (btn.dataset.tab === tabName) {
            btn.classList.add("active");
        } else {
            btn.classList.remove("active");
        }
    });

    // Update views viewport
    document.querySelectorAll(".view-viewport .tab-panel").forEach(panel => {
        if (panel.id === `view-${tabName}`) {
            panel.classList.add("active");
        } else {
            panel.classList.remove("active");
        }
    });

    // Trigger tab-specific refresh actions
    if (tabName === "dashboard") {
        renderDashboardData();
    } else if (tabName === "reports") {
        renderReportsGrid();
    } else if (tabName === "approvals") {
        renderApprovalsTables();
    } else if (tabName === "collections") {
        renderCollectionsView();
    } else if (tabName === "catalogues") {
        renderCataloguesTables();
    } else if (tabName === "planning") {
        renderPlanningCalendar();
    }
}

function initThemeToggle() {
    const btn = document.querySelector(".theme-toggle");
    if (!btn) return;
    btn.addEventListener("click", () => {
        const body = document.body;
        if (body.classList.contains("light-theme")) {
            body.classList.remove("light-theme");
            btn.innerHTML = '<i class="fa-solid fa-moon"></i>';
        } else {
            body.classList.add("light-theme");
            btn.innerHTML = '<i class="fa-solid fa-sun"></i>';
        }
    });
}

// ==========================================================================
// MODULE 1: Dashboard View
// ==========================================================================

function initDashboard() {
    // Connect Dashboard filter event listeners
    const clientSelect = document.getElementById("db-filter-client");
    const plateSelect = document.getElementById("db-filter-plate");
    const driverSelect = document.getElementById("db-filter-driver");
    const projectSelect = document.getElementById("db-filter-project");
    const clearBtn = document.getElementById("btn-clear-db-filters");

    if (clientSelect) {
        clientSelect.addEventListener("change", (e) => {
            state.dashboardFilters.client = e.target.value;
            renderDashboardData();
        });
    }
    if (plateSelect) {
        plateSelect.addEventListener("change", (e) => {
            state.dashboardFilters.plate = e.target.value;
            renderDashboardData();
        });
    }
    if (driverSelect) {
        driverSelect.addEventListener("change", (e) => {
            state.dashboardFilters.driver = e.target.value;
            renderDashboardData();
        });
    }
    if (projectSelect) {
        projectSelect.addEventListener("change", (e) => {
            state.dashboardFilters.project = e.target.value;
            renderDashboardData();
        });
    }
    if (clearBtn) {
        clearBtn.addEventListener("click", () => {
            state.dashboardFilters = { client: "", plate: "", driver: "", project: "" };
            if (clientSelect) clientSelect.value = "";
            if (plateSelect) plateSelect.value = "";
            if (driverSelect) driverSelect.value = "";
            if (projectSelect) projectSelect.value = "";
            renderDashboardData();
        });
    }

    renderDashboardData();
}

function getFilteredDashboard() {
    const f = state.dashboardFilters;
    
    // 1. Filter guides by explicit filters and search query
    const filteredGuides = state.guides.filter(g => {
        const matchesClient = !f.client || String(g.contact_id) === f.client;
        const matchesPlate = !f.plate || g.plate_code === f.plate;
        const matchesDriver = !f.driver || String(g.driver_id) === f.driver;
        const matchesProject = !f.project || g.project === f.project;
        
        let matchesQuery = true;
        if (state.dashboardSearchQuery) {
            const q = state.dashboardSearchQuery.toLowerCase();
            const clientName = (g.client_name || "").toLowerCase();
            const plate = (g.plate_code || "").toLowerCase();
            const driver = (g.driver_name || "").toLowerCase();
            const project = (g.project || "").toLowerCase();
            const desc = (g.description || "").toLowerCase();
            const gNum = (g.guide_number || "").toLowerCase();
            const prodName = (g.product_name || "").toLowerCase();
            
            matchesQuery = clientName.includes(q) || 
                           plate.includes(q) || 
                           driver.includes(q) || 
                           project.includes(q) || 
                           desc.includes(q) || 
                           gNum.includes(q) ||
                           prodName.includes(q);
        }
        
        return matchesClient && matchesPlate && matchesDriver && matchesProject && matchesQuery;
    });

    // 2. Filter invoices
    const filteredInvoiceIds = new Set(filteredGuides.map(g => g.invoice_id).filter(Boolean));
    const filteredInvoices = state.invoices.filter(inv => {
        const matchesClient = !f.client || String(inv.client_id) === f.client;
        const hasOtherFilters = f.plate || f.driver || f.project || state.dashboardSearchQuery;
        const matchesLinkedGuides = !hasOtherFilters || filteredInvoiceIds.has(inv.id);
        
        let matchesQuery = true;
        if (state.dashboardSearchQuery && !hasOtherFilters) {
            const q = state.dashboardSearchQuery.toLowerCase();
            const clientName = (inv.client_name || "").toLowerCase();
            const invId = `fact-${inv.id}`;
            matchesQuery = clientName.includes(q) || invId.includes(q);
        }
        
        return matchesClient && matchesLinkedGuides && matchesQuery;
    });

    // 3. Recalculate KPIs
    const totalBilled = filteredInvoices
        .filter(inv => inv.approval_status === "Aprobada")
        .reduce((sum, inv) => sum + (inv.total || 0), 0);

    const totalPending = filteredInvoices
        .filter(inv => inv.approval_status === "Aprobada")
        .reduce((sum, inv) => sum + (inv.amount_pending || 0), 0);

    const activeMachinery = state.machinery.filter(m => {
        const matchesPlate = !f.plate || m.plate_code === f.plate;
        const matchesDriver = !f.driver || String(m.driver_id) === f.driver;
        return matchesPlate && matchesDriver && m.maintenance_status === "Operativo";
    }).length;

    const unbilledGuides = filteredGuides.filter(g => g.billing_status === "Pendiente").length;

    // Top Debtors
    const debtorMap = {};
    filteredInvoices.forEach(inv => {
        if (inv.approval_status === "Aprobada" && inv.payment_status !== "Pagada") {
            const clientName = inv.client_name;
            debtorMap[clientName] = (debtorMap[clientName] || 0) + (inv.amount_pending || 0);
        }
    });
    const topDebtors = Object.entries(debtorMap)
        .map(([name, pending]) => ({ name, pending }))
        .sort((a, b) => b.pending - a.pending)
        .slice(0, 5);

    // 4. Recalculate Charts Data
    // Driver Productivity
    const driverMap = {};
    filteredGuides.forEach(g => {
        if (g.driver_name) {
            driverMap[g.driver_name] = (driverMap[g.driver_name] || 0) + (g.quantity || 0);
        }
    });
    const driverProductivity = Object.entries(driverMap)
        .map(([name, total_work]) => ({ name, total_work }));

    // Machinery Productivity
    const machineryProductivity = state.machinery.filter(m => {
        const matchesPlate = !f.plate || m.plate_code === f.plate;
        const matchesDriver = !f.driver || String(m.driver_id) === f.driver;
        return matchesPlate && matchesDriver;
    }).map(m => {
        const totalJobs = filteredGuides.filter(g => g.plate_code === m.plate_code).length;
        return {
            plate_code: m.plate_code,
            type: m.type,
            accumulated_hours_km: m.accumulated_hours_km || 0,
            total_jobs: totalJobs
        };
    });

    // Revenue per vehicle
    const revMap = {};
    filteredGuides.forEach(g => {
        if (g.plate_code) {
            const revenue = (g.quantity || 0) * (g.product_price || 0);
            revMap[g.plate_code] = (revMap[g.plate_code] || 0) + revenue;
        }
    });
    const revenuePerVehicle = Object.entries(revMap)
        .map(([plate_code, revenue]) => ({ plate_code, revenue }))
        .sort((a, b) => b.revenue - a.revenue);

    return {
        kpis: {
            total_billed: totalBilled,
            total_pending: totalPending,
            active_machinery: activeMachinery,
            unbilled_guides: unbilledGuides,
            top_debtors: topDebtors
        },
        chartsData: {
            driver_productivity: driverProductivity,
            machinery_productivity: machineryProductivity,
            revenue_per_vehicle: revenuePerVehicle
        }
    };
}

function renderDashboardData() {
    const data = getFilteredDashboard();
    const kpis = data.kpis;
    const chartsData = data.chartsData;
    
    // Populate cards
    document.getElementById("kpi-total-billed").textContent = formatCurrency(kpis.total_billed || 0);
    document.getElementById("kpi-total-pending").textContent = formatCurrency(kpis.total_pending || 0);
    document.getElementById("kpi-active-machinery").textContent = kpis.active_machinery || 0;
    document.getElementById("kpi-unbilled-guides").textContent = kpis.unbilled_guides || 0;

    // Debtors table
    const debtorsTbl = document.getElementById("tbl-dashboard-debtors");
    debtorsTbl.innerHTML = "";
    if (kpis.top_debtors && kpis.top_debtors.length > 0) {
        kpis.top_debtors.forEach(d => {
            const row = document.createElement("tr");
            row.innerHTML = `
                <td><strong>${d.name}</strong></td>
                <td class="text-right text-red font-weight-bold">${formatCurrency(d.pending)}</td>
            `;
            debtorsTbl.appendChild(row);
        });
    } else {
        debtorsTbl.innerHTML = '<tr><td colspan="2" class="text-center text-muted">No hay deudas activas</td></tr>';
    }

    // Machinery Hours table
    const machTbl = document.getElementById("tbl-dashboard-machinery");
    machTbl.innerHTML = "";
    if (chartsData.machinery_productivity) {
        chartsData.machinery_productivity.forEach(m => {
            const row = document.createElement("tr");
            row.innerHTML = `
                <td><strong>${m.plate_code}</strong></td>
                <td>${m.type}</td>
                <td class="text-center font-weight-bold">${m.accumulated_hours_km.toFixed(1)} h</td>
                <td class="text-center">${m.total_jobs} viajes</td>
            `;
            machTbl.appendChild(row);
        });
    }

    // Draw Chart.js graphs
    renderDashboardCharts(chartsData);
}

function renderDashboardCharts(cData) {
    if (!cData || !cData.revenue_per_vehicle || !cData.driver_productivity) return;

    // 1. Revenue per Vehicle (Bar Chart)
    const revCanvas = document.getElementById("chart-revenue-vehicle");
    if (revCanvas) {
        if (charts.revenue) charts.revenue.destroy();
        
        const labels = cData.revenue_per_vehicle.map(x => x.plate_code);
        const data = cData.revenue_per_vehicle.map(x => x.revenue);

        charts.revenue = new Chart(revCanvas, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Ingresos Generados ($)',
                    data: data,
                    backgroundColor: 'rgba(59, 130, 246, 0.65)',
                    borderColor: '#3b82f6',
                    borderWidth: 1,
                    borderRadius: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: { color: '#9ca3af' },
                        grid: { color: 'rgba(255, 255, 255, 0.05)' }
                    },
                    x: {
                        ticks: { color: '#9ca3af' },
                        grid: { display: false }
                    }
                }
            }
        });
    }

    // 2. Driver Productivity (Horizontal Bar / Pie)
    const prodCanvas = document.getElementById("chart-driver-productivity");
    if (prodCanvas) {
        if (charts.productivity) charts.productivity.destroy();

        const labels = cData.driver_productivity.map(x => x.name);
        const data = cData.driver_productivity.map(x => x.total_work);

        charts.productivity = new Chart(prodCanvas, {
            type: 'doughnut',
            data: {
                labels: labels,
                datasets: [{
                    data: data,
                    backgroundColor: [
                        'rgba(139, 92, 246, 0.75)',
                        'rgba(16, 185, 129, 0.75)',
                        'rgba(245, 158, 11, 0.75)',
                        'rgba(6, 182, 212, 0.75)'
                    ],
                    borderColor: 'rgba(21, 27, 44, 0.9)',
                    borderWidth: 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'right',
                        labels: { color: '#9ca3af', font: { size: 11 } }
                    }
                }
            }
        });
    }
}

// ==========================================================================
// MODULE 2: Carga Guías & OCR Module
// ==========================================================================

function initOCRModule() {
    const dropzone = document.getElementById("ocr-dropzone");
    const fileInput = document.getElementById("ocr-file-input");
    const previewContainer = document.getElementById("ocr-preview-container");
    const previewImg = document.getElementById("ocr-preview-img");
    const btnClear = document.getElementById("btn-clear-preview");
    const form = document.getElementById("form-ocr-review");
    const btnSave = document.getElementById("btn-ocr-save");
    const statusBadge = document.getElementById("ocr-status-badge");

    // Click triggers file open
    dropzone.addEventListener("click", (e) => {
        if (e.target !== btnClear && !btnClear.contains(e.target)) {
            fileInput.click();
        }
    });

    // Drag over styling
    dropzone.addEventListener("dragover", (e) => {
        e.preventDefault();
        dropzone.classList.add("active");
    });

    dropzone.addEventListener("dragleave", () => {
        dropzone.classList.remove("active");
    });

    dropzone.addEventListener("drop", (e) => {
        e.preventDefault();
        dropzone.classList.remove("active");
        if (e.dataTransfer.files.length > 0) {
            handleUploadedFiles(e.dataTransfer.files);
        }
    });

    fileInput.addEventListener("change", () => {
        if (fileInput.files.length > 0) {
            handleUploadedFiles(fileInput.files);
        }
    });

    btnClear.addEventListener("click", (e) => {
        e.stopPropagation();
        resetOCRForm();
    });

    // Reset button
    document.getElementById("btn-ocr-reset").addEventListener("click", () => {
        resetOCRForm();
    });

    // Bulk queue actions
    document.getElementById("btn-save-all-ready").addEventListener("click", handleSaveAllReady);
    document.getElementById("btn-clear-queue").addEventListener("click", () => {
        if (confirm("¿Está seguro de vaciar la cola de carga masiva?")) {
            resetOCRForm();
        }
    });

    // Form submit
    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        
        const payload = {
            guide_number: document.getElementById("ocr-guide-num").value,
            guide_date: document.getElementById("ocr-guide-date").value,
            description: document.getElementById("ocr-desc").value,
            quantity: parseFloat(document.getElementById("ocr-qty").value),
            unit: document.getElementById("ocr-unit").value,
            project: document.getElementById("ocr-project").value,
            contact_id: document.getElementById("ocr-client").value ? parseInt(document.getElementById("ocr-client").value) : null,
            plate_code: document.getElementById("ocr-plate").value || null,
            product_id: document.getElementById("ocr-product").value ? parseInt(document.getElementById("ocr-product").value) : null,
            driver_id: document.getElementById("ocr-driver").value ? parseInt(document.getElementById("ocr-driver").value) : null,
            signature_detected: document.getElementById("ocr-signature").checked ? 1 : 0,
            hours_worked: parseFloat(document.getElementById("ocr-hours").value || 0),
            purchase_order: document.getElementById("ocr-purchase-order").value,
            recompra: document.getElementById("ocr-recompra").value,
            resident: document.getElementById("ocr-resident").value
        };

        try {
            await fetchAPI("/guides", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });
            
            // Mark item as saved in queue
            if (state.ocrQueue.length > 0) {
                const activeItem = state.ocrQueue.find(x => x.id === state.ocrActiveId);
                if (activeItem) {
                    activeItem.status = "Guardado";
                    activeItem.extractedData = { ...activeItem.extractedData, ...payload };
                }

                // Auto-advance to next item needing validation
                const nextItem = state.ocrQueue.find(x => x.status === "Listo" || x.status === "Error");
                if (nextItem) {
                    selectQueueItem(nextItem.id);
                } else {
                    const allProcessed = state.ocrQueue.every(x => x.status === "Guardado" || x.status === "Error");
                    if (allProcessed) {
                        alert("Todas las guías de la cola han sido procesadas.");
                        resetOCRForm();
                        await refreshAllData();
                        switchTab("reports");
                    } else {
                        // Select first unfinished
                        const pendingItem = state.ocrQueue.find(x => x.status !== "Guardado");
                        if (pendingItem) selectQueueItem(pendingItem.id);
                    }
                }
            } else {
                alert("Guía de trabajo guardada con éxito.");
                resetOCRForm();
                await refreshAllData();
                switchTab("reports");
            }
            await refreshAllData();
        } catch (err) {
            alert(`Error al guardar la guía: ${err.message}`);
        }
    });
}

async function handleUploadedFiles(files) {
    const fileList = Array.from(files);
    if (fileList.length === 0) return;

    const previewContainer = document.getElementById("ocr-preview-container");
    const dropzonePrompt = document.querySelector(".dropzone-prompt");
    previewContainer.style.display = "none";
    dropzonePrompt.style.display = "flex";

    const newItems = fileList.map(file => {
        const id = Date.now() + Math.random();
        const previewUrl = URL.createObjectURL(file);
        return {
            id: id,
            file: file,
            fileName: file.name,
            previewUrl: previewUrl,
            status: "Pendiente",
            extractedData: null,
            error: null
        };
    });

    state.ocrQueue = [...state.ocrQueue, ...newItems];

    // Select first newly added item if none active or current is saved
    const currentActive = state.ocrQueue.find(x => x.id === state.ocrActiveId);
    if (!state.ocrActiveId || !currentActive || currentActive.status === "Guardado") {
        state.ocrActiveId = newItems[0].id;
    }

    renderOCRQueue();
    selectQueueItem(state.ocrActiveId);
    processOCRQueue();
}

async function processOCRQueue() {
    const pendingItems = state.ocrQueue.filter(item => item.status === "Pendiente");
    if (pendingItems.length === 0) return;

    // Concurrency limit of 2 calls to prevent rate limits or timeout
    const limit = 2;
    let running = 0;
    let index = 0;

    async function next() {
        if (index >= pendingItems.length) return;
        const item = pendingItems[index++];
        running++;

        try {
            item.status = "Procesando";
            renderOCRQueue();
            if (state.ocrActiveId === item.id) selectQueueItem(item.id);

            const formData = new FormData();
            formData.append("file", item.file);

            const extracted = await fetchAPI("/upload", {
                method: "POST",
                body: formData
            });

            item.extractedData = extracted;
            item.status = "Listo";
        } catch (err) {
            item.status = "Error";
            item.error = err.message;
        } finally {
            running--;
            renderOCRQueue();
            if (state.ocrActiveId === item.id) selectQueueItem(item.id);
            await next();
        }
    }

    const workers = [];
    for (let i = 0; i < Math.min(limit, pendingItems.length); i++) {
        workers.push(next());
    }
    await Promise.all(workers);
}

function renderOCRQueue() {
    const queueSection = document.getElementById("ocr-bulk-queue-section");
    const queueList = document.getElementById("ocr-queue-list");
    const queueCount = document.getElementById("ocr-queue-count");
    const btnSaveAll = document.getElementById("btn-save-all-ready");

    if (state.ocrQueue.length === 0) {
        queueSection.style.display = "none";
        return;
    }

    queueSection.style.display = "block";
    queueCount.textContent = state.ocrQueue.length;
    queueList.innerHTML = "";

    const hasReady = state.ocrQueue.some(item => item.status === "Listo");
    btnSaveAll.disabled = !hasReady;

    state.ocrQueue.forEach(item => {
        const div = document.createElement("div");
        div.className = `ocr-queue-item ${item.status.toLowerCase()} ${item.id === state.ocrActiveId ? 'active' : ''}`;
        
        let statusIcon = '<i class="fa-solid fa-clock text-muted"></i>';
        if (item.status === "procesando") statusIcon = '<i class="fa-solid fa-spinner fa-spin text-warning"></i>';
        else if (item.status === "listo") statusIcon = '<i class="fa-solid fa-circle-check text-info"></i>';
        else if (item.status === "guardado") statusIcon = '<i class="fa-solid fa-circle-check text-emerald"></i>';
        else if (item.status === "error") statusIcon = '<i class="fa-solid fa-triangle-exclamation text-red"></i>';

        const guideInfo = item.extractedData && item.extractedData.guide_number 
            ? `N° ${item.extractedData.guide_number}` 
            : (item.status === "listo" ? "Listo" : item.status.charAt(0).toUpperCase() + item.status.slice(1));

        div.innerHTML = `
            <img class="item-preview" src="${item.previewUrl}" alt="Pre">
            <div class="item-details">
                <h5>${item.fileName}</h5>
                <p>${guideInfo}</p>
            </div>
            <div class="item-status">${statusIcon}</div>
        `;

        div.addEventListener("click", () => {
            selectQueueItem(item.id);
        });

        queueList.appendChild(div);
    });
}

function selectQueueItem(itemId) {
    state.ocrActiveId = itemId;
    
    // Highlight item in sidebar
    document.querySelectorAll(".ocr-queue-item").forEach(el => el.classList.remove("active"));
    const activeItemEl = Array.from(document.querySelectorAll(".ocr-queue-item")).find(el => {
        return el.classList.contains(itemId.toString()) || el.innerHTML.includes(itemId.toString());
    });
    // Re-render queue to easily maintain visual active states
    const items = state.ocrQueue;
    const item = items.find(x => x.id === itemId);
    if (!item) return;

    // We manually update active class
    const queueList = document.getElementById("ocr-queue-list");
    Array.from(queueList.children).forEach((child, idx) => {
        if (items[idx] && items[idx].id === itemId) {
            child.classList.add("active");
        } else {
            child.classList.remove("active");
        }
    });

    const dropzonePrompt = document.querySelector(".dropzone-prompt");
    const previewContainer = document.getElementById("ocr-preview-container");
    const previewImg = document.getElementById("ocr-preview-img");
    
    previewImg.src = item.previewUrl;
    dropzonePrompt.style.display = "none";
    previewContainer.style.display = "flex";

    const form = document.getElementById("form-ocr-review");
    const btnSave = document.getElementById("btn-ocr-save");
    const statusBadge = document.getElementById("ocr-status-badge");

    if (item.status === "Procesando") {
        statusBadge.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Procesando OCR...';
        statusBadge.className = "status-badge warning";
        btnSave.disabled = true;
        form.reset();
    } else if (item.status === "Listo") {
        statusBadge.innerHTML = '<i class="fa-solid fa-circle-check"></i> Listo para Validar';
        statusBadge.className = "status-badge success";
        btnSave.disabled = false;
        populateOCRForm(item.extractedData);
    } else if (item.status === "Guardado") {
        statusBadge.innerHTML = '<i class="fa-solid fa-circle-check text-emerald"></i> Guía Guardada';
        statusBadge.className = "status-badge success";
        btnSave.disabled = true;
        populateOCRForm(item.extractedData);
    } else if (item.status === "Error") {
        statusBadge.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Error: ${item.error || 'Lectura fallida'}`;
        statusBadge.className = "status-badge danger";
        btnSave.disabled = false;
        form.reset();
    } else {
        statusBadge.innerHTML = '<i class="fa-solid fa-clock"></i> En Cola';
        statusBadge.className = "status-badge warning";
        btnSave.disabled = true;
        form.reset();
    }
}

function populateOCRForm(data) {
    if (!data) return;
    document.getElementById("ocr-guide-num").value = data.guide_number || "";
    document.getElementById("ocr-guide-date").value = data.guide_date || "";
    document.getElementById("ocr-desc").value = data.description || "";
    document.getElementById("ocr-qty").value = data.quantity || 1.0;
    document.getElementById("ocr-unit").value = data.unit || "VIAJE";
    document.getElementById("ocr-project").value = data.project || "";
    document.getElementById("ocr-hours").value = data.hours_worked || 0.0;
    document.getElementById("ocr-signature").checked = data.signature_detected === 1;
    document.getElementById("ocr-purchase-order").value = data.purchase_order || "";
    document.getElementById("ocr-recompra").value = data.recompra || "";
    document.getElementById("ocr-resident").value = data.resident || "";

    // Dropdowns values (DB matching)
    document.getElementById("ocr-client").value = data.contact_id || "";
    document.getElementById("ocr-driver").value = data.driver_id || "";
    document.getElementById("ocr-plate").value = data.plate_code || "";
    document.getElementById("ocr-product").value = data.product_id || "";
}

async function handleSaveAllReady() {
    const readyItems = state.ocrQueue.filter(item => item.status === "Listo");
    if (readyItems.length === 0) return;

    if (!confirm(`¿Está seguro de guardar las ${readyItems.length} guías listas de forma masiva con los valores extraídos por el OCR?`)) return;

    let savedCount = 0;
    let failCount = 0;

    for (const item of readyItems) {
        const data = item.extractedData;
        
        const payload = {
            guide_number: data.guide_number,
            guide_date: data.guide_date,
            description: data.description || "",
            quantity: parseFloat(data.quantity || 1.0),
            unit: data.unit || "VIAJE",
            project: data.project || "",
            contact_id: data.contact_id ? parseInt(data.contact_id) : null,
            plate_code: data.plate_code || null,
            product_id: data.product_id ? parseInt(data.product_id) : null,
            driver_id: data.driver_id ? parseInt(data.driver_id) : null,
            signature_detected: data.signature_detected ? 1 : 0,
            hours_worked: parseFloat(data.hours_worked || 0.0),
            purchase_order: data.purchase_order || "",
            recompra: data.recompra || "",
            resident: data.resident || ""
        };

        try {
            await fetchAPI("/guides", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });
            item.status = "Guardado";
            item.extractedData = { ...item.extractedData, ...payload };
            savedCount++;
        } catch (err) {
            console.error(`Error saving guide ${data.guide_number}:`, err);
            item.status = "Error";
            item.error = err.message;
            failCount++;
        }
    }

    renderOCRQueue();
    
    const nextItem = state.ocrQueue.find(x => x.status !== "Guardado");
    if (nextItem) {
        selectQueueItem(nextItem.id);
    } else {
        alert(`Proceso masivo completado. Guardadas con éxito: ${savedCount}. Fallidas: ${failCount}.`);
        resetOCRForm();
        await refreshAllData();
        switchTab("reports");
    }
}

function resetOCRForm() {
    const dropzonePrompt = document.querySelector(".dropzone-prompt");
    const previewContainer = document.getElementById("ocr-preview-container");
    const previewImg = document.getElementById("ocr-preview-img");
    const fileInput = document.getElementById("ocr-file-input");
    const statusBadge = document.getElementById("ocr-status-badge");
    const btnSave = document.getElementById("btn-ocr-save");
    const form = document.getElementById("form-ocr-review");

    fileInput.value = "";
    previewImg.src = "";
    previewContainer.style.display = "none";
    dropzonePrompt.style.display = "flex";

    form.reset();
    statusBadge.innerHTML = '<i class="fa-solid fa-info"></i> Esperando Archivo';
    statusBadge.className = "status-badge warning";
    btnSave.disabled = true;

    // Reset queue state
    state.ocrQueue = [];
    state.ocrActiveId = null;
    renderOCRQueue();
}

// ==========================================================================
// MODULE 3: Reportes & Facturación Masiva (Grid Inteligente)
// ==========================================================================

function initReportsGrid() {
    // Connect filter event listeners
    document.getElementById("filter-client").addEventListener("change", applyFilters);
    document.getElementById("filter-plate").addEventListener("change", applyFilters);
    document.getElementById("filter-status").addEventListener("change", applyFilters);
    document.getElementById("group-by-select").addEventListener("change", (e) => {
        state.groupBy = e.target.value;
        state.expandedGroups = {}; // reset open state
        renderReportsGrid();
    });

    // Mass Invoicing button
    document.getElementById("btn-mass-invoice").addEventListener("click", handleMassInvoicing);

    // Grid Master Checkbox
    const chkAll = document.getElementById("chk-select-all-guides");
    if (chkAll) {
        chkAll.addEventListener("change", (e) => {
            const checked = e.target.checked;
            document.querySelectorAll(".guide-checkbox:not(:disabled)").forEach(chk => {
                chk.checked = checked;
            });
        });
    }

    // Export Excel & PDF
    document.getElementById("btn-export-excel").addEventListener("click", exportGridToExcel);
    document.getElementById("btn-export-pdf").addEventListener("click", exportGridToPDF);
}

function applyFilters() {
    state.filters.client = document.getElementById("filter-client").value;
    state.filters.plate = document.getElementById("filter-plate").value;
    state.filters.status = document.getElementById("filter-status").value;

    state.gridGuides = state.guides.filter(g => {
        const matchesClient = !state.filters.client || String(g.contact_id) === state.filters.client;
        const matchesPlate = !state.filters.plate || g.plate_code === state.filters.plate;
        const matchesStatus = !state.filters.status || g.billing_status === state.filters.status;
        return matchesClient && matchesPlate && matchesStatus;
    });

    renderReportsGrid();
}

function renderReportsGrid() {
    const tbody = document.getElementById("guides-grid-body");
    tbody.innerHTML = "";

    // Sort guides
    const col = state.gridSort.col;
    const dir = state.gridSort.dir === "asc" ? 1 : -1;
    state.gridGuides.sort((a, b) => {
        let valA = a[col] || "";
        let valB = b[col] || "";
        if (typeof valA === "string") valA = valA.toLowerCase();
        if (typeof valB === "string") valB = valB.toLowerCase();
        
        if (valA < valB) return -1 * dir;
        if (valA > valB) return 1 * dir;
        return 0;
    });

    // Render grouped vs flat table
    if (state.groupBy) {
        renderGroupedGrid(tbody);
    } else {
        renderFlatGrid(tbody);
    }
}

function renderFlatGrid(tbody) {
    if (state.gridGuides.length === 0) {
        tbody.innerHTML = '<tr><td colspan="18" class="text-center text-muted">No se encontraron registros para la búsqueda.</td></tr>';
        return;
    }

    state.gridGuides.forEach(g => {
        const row = createGuideRow(g);
        tbody.appendChild(row);
    });
}

function renderGroupedGrid(tbody) {
    // 1. Group data in Javascript
    const groups = {};
    state.gridGuides.forEach(g => {
        let key = g[state.groupBy];
        if (key === null || key === undefined || key === "") key = "Sin Asignar";
        if (!groups[key]) groups[key] = [];
        groups[key].push(g);
    });

    const sortedGroupKeys = Object.keys(groups).sort();
    
    // 2. Render each group
    sortedGroupKeys.forEach(gKey => {
        const groupItems = groups[gKey];
        const isExpanded = state.expandedGroups[gKey] !== false; // default to true (expanded)

        // Calculate group totals
        const totalQty = groupItems.reduce((acc, curr) => acc + curr.quantity, 0);
        const totalVal = groupItems.reduce((acc, curr) => acc + (curr.quantity * (curr.product_price || 0)), 0);
        
        // Group Header row
        const headerRow = document.createElement("tr");
        headerRow.className = `group-header-row ${isExpanded ? '' : 'collapsed'}`;
        headerRow.dataset.groupKey = gKey;
        
        headerRow.innerHTML = `
            <td colspan="11">
                <span class="group-toggle-icon"><i class="fa-solid fa-chevron-down"></i></span>
                <strong>${formatGroupHeaderLabel(state.groupBy, gKey)}</strong> 
                <span class="text-muted">(${groupItems.length} registros)</span>
            </td>
            <td class="text-right font-weight-bold">${totalQty.toFixed(2)}</td>
            <td></td>
            <td></td>
            <td class="text-right font-weight-bold">${formatCurrency(totalVal)}</td>
            <td colspan="3"></td>
        `;

        headerRow.addEventListener("click", () => {
            state.expandedGroups[gKey] = !isExpanded;
            renderReportsGrid();
        });

        tbody.appendChild(headerRow);

        // Render detail rows if expanded
        if (isExpanded) {
            groupItems.forEach(item => {
                const row = createGuideRow(item, true); // true to add visual indent class if desired
                tbody.appendChild(row);
            });
        }
    });
}

function formatGroupHeaderLabel(groupBy, key) {
    const labels = {
        client_name: "Cliente",
        project: "Obra / Proyecto",
        plate_code: "Vehículo / Placa",
        driver_name: "Chofer",
        billing_status: "Estado Facturación"
    };
    return `${labels[groupBy] || groupBy}: ${key}`;
}

function createGuideRow(g, isGrouped = false) {
    const tr = document.createElement("tr");
    if (isGrouped) {
        tr.style.backgroundColor = "rgba(255, 255, 255, 0.01)";
    }
    
    const price = g.product_price || 0.0;
    const total = g.quantity * price;
    
    let badgeClass = "warning";
    if (g.billing_status === "Facturado") badgeClass = "success";
    else if (g.billing_status === "En Proceso") badgeClass = "info";

    const isSelectable = g.billing_status === "Pendiente";
    const chkDisabled = isSelectable ? "" : "disabled";

    tr.innerHTML = `
        <td class="chk-col"><input type="checkbox" class="guide-checkbox" value="${g.id}" ${chkDisabled}></td>
        <td>${formatDateString(g.guide_date)}</td>
        <td><strong>${g.guide_number}</strong></td>
        <td>${g.client_name || '<span class="text-red">Sin cliente</span>'}</td>
        <td>${g.project || '--'}</td>
        <td>${g.resident || '--'}</td>
        <td>${g.purchase_order || '--'}</td>
        <td>${g.recompra || '--'}</td>
        <td>${g.plate_code || '--'}</td>
        <td>${g.driver_name || '--'}</td>
        <td><span class="text-muted">${g.product_name || '--'}</span><br><small>${g.description || ''}</small></td>
        <td class="text-right font-weight-bold">${g.quantity}</td>
        <td class="text-center"><span class="text-muted">${g.unit}</span></td>
        <td class="text-right">${formatCurrency(price)}</td>
        <td class="text-right font-weight-bold">${formatCurrency(total)}</td>
        <td class="text-center">${g.signature_detected ? '<i class="fa-solid fa-signature text-emerald"></i>' : '<i class="fa-solid fa-xmark text-muted"></i>'}</td>
        <td class="text-center"><span class="status-badge ${badgeClass}">${g.billing_status}</span></td>
        <td class="actions-col">
            <button class="btn btn-outline btn-sm" onclick="handleDeleteGuide(${g.id})"><i class="fa-solid fa-trash"></i></button>
        </td>
    `;
    return tr;
}

async function handleDeleteGuide(id) {
    if (!confirm("¿Está seguro de eliminar esta guía de trabajo? Esta acción revertirá también las horas registradas en el horómetro de la maquinaria correspondiente.")) return;
    try {
        await fetchAPI(`/guides/${id}`, { method: "DELETE" });
        await refreshAllData();
        applyFilters();
    } catch (err) {
        alert(err.message);
    }
}

async function handleMassInvoicing() {
    const selectedCheckboxes = document.querySelectorAll(".guide-checkbox:checked");
    if (selectedCheckboxes.length === 0) {
        alert("Por favor, seleccione al menos una guía de trabajo.");
        return;
    }

    const guideIds = Array.from(selectedCheckboxes).map(chk => parseInt(chk.value));
    const ivaPercentage = parseFloat(document.getElementById("mass-iva-rate").value || 15.0);

    try {
        const res = await fetchAPI("/invoices/generate-mass", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ guide_ids: guideIds, iva_percentage: ivaPercentage })
        });

        alert(`Pre-facturas generadas: ${res.invoices.length} factura(s).`);
        await refreshAllData();
        switchTab("approvals");
    } catch (err) {
        alert(`Error: ${err.message}`);
    }
}

// --- EXPORT CONTROLS ---

function exportGridToExcel() {
    const wb = XLSX.utils.book_new();
    
    // Check if we have guides to export
    if (state.gridGuides.length === 0) {
        alert("No hay registros para exportar.");
        return;
    }
    
    // Detect active client from dropdown filter or the first row
    let activeClient = "";
    const clientSelect = document.getElementById("filter-client");
    if (clientSelect && clientSelect.value) {
        const selectedOption = clientSelect.options[clientSelect.selectedIndex];
        activeClient = selectedOption.text.toUpperCase();
    } else if (state.gridGuides[0] && state.gridGuides[0].client_name) {
        activeClient = state.gridGuides[0].client_name.toUpperCase();
    }
    
    let ws;
    let filename = "";
    
    if (activeClient.includes("HYDRIA")) {
        // HYDRIAPAC Layout matching REPORTE HYDRIAPAC LUIS.xlsx
        filename = `Reporte_Hydriapac_${new Date().toISOString().slice(0,10)}.xlsx`;
        const aoa = [
            [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null],
            ["REPORTE HYDRIAPAC", null, null, null, null, null, null, null, null, null, null, null, null, null, null],
            [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null],
            ["FECHA", "GUIA", "PLACA", "UNI.", "CANT.", "PRECIO", "TOTAL", "MATERIAL/DESCRIPCION", "RESI", "OBRA", "OC", "RC", "FACT", "E.H/G", "R.GABR."]
        ];
        
        state.gridGuides.forEach((g, idx) => {
            const rowNum = idx + 5; // row index in Excel (1-based, starts at 5)
            const price = g.product_price || 0;
            
            aoa.push([
                g.guide_date,
                parseInt(g.guide_number) || g.guide_number,
                (g.plate_code || "").replace("-", "").toUpperCase(), // GSI3442 style
                g.unit,
                g.quantity,
                price,
                { f: `E${rowNum}*F${rowNum}` }, // Dynamic formula!
                g.product_name || "",
                g.resident || "",
                g.project || "",
                g.purchase_order || "",
                g.recompra || "",
                g.invoice_id ? `FA-${g.invoice_id}` : "",
                "",
                ""
            ]);
        });
        
        ws = XLSX.utils.aoa_to_sheet(aoa);
        
        // Add merge for title
        ws['!merges'] = [
            { s: { r: 1, c: 0 }, e: { r: 1, c: 7 } } // Merge title
        ];
    } 
    else if (activeClient.includes("RIPCONCIV") || activeClient.includes("VENTO")) {
        // RIPCONCIV / DI VENTO Layout matching REPORTE RIPCONCIV DIVENTO LUIS.xlsx
        filename = `Reporte_Ripconciv_${new Date().toISOString().slice(0,10)}.xlsx`;
        const aoa = [
            ["REPORTES DI VENTO", null, null, null, null, null, null, null, null, null, null],
            ["FECHA", "GUIA", "PLACA", "UNI.", "CANTIDAD", "TRANSPORTE", "PRECIO", "TOTAL", "MATERIAL/DESCRIPCION", "FACT", "ESTADO"]
        ];
        
        state.gridGuides.forEach((g, idx) => {
            const rowNum = idx + 3; // row index in Excel (1-based, starts at 3)
            const price = g.product_price || 0;
            const isTransport = (g.product_name || "").toUpperCase().includes("TRANSPORTE") || 
                                (g.product_name || "").toUpperCase().includes("ALQUILER") ||
                                (g.product_name || "").toUpperCase().includes("MULA");
            
            const transporteVal = isTransport ? price : 0;
            const precioVal = isTransport ? 0 : price;
            
            aoa.push([
                g.guide_date,
                parseInt(g.guide_number) || g.guide_number,
                (g.plate_code || "").replace("-", "").toUpperCase(),
                g.unit,
                g.quantity,
                transporteVal,
                precioVal,
                { f: `(F${rowNum}+G${rowNum})*E${rowNum}` }, // Dynamic formula!
                g.product_name || "",
                g.invoice_id ? `FA-${g.invoice_id}` : "",
                g.billing_status || ""
            ]);
        });
        
        ws = XLSX.utils.aoa_to_sheet(aoa);
        ws['!merges'] = [
            { s: { r: 0, c: 0 }, e: { r: 0, c: 4 } }
        ];
    }
    else {
        // Standard Unified Layout
        filename = `Reporte_Guias_${new Date().toISOString().slice(0,10)}.xlsx`;
        const aoa = [
            ["REPORTE GENERAL DE TRANSPORTES", null, null, null, null, null, null, null, null, null, null, null, null, null, null],
            [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null],
            ["FECHA", "GUIA", "CLIENTE", "OBRA / PROYECTO", "RESIDENTE", "OC", "RC", "PLACA", "CHOFER", "MATERIAL/DESCRIPCION", "CANT.", "UNI.", "PRECIO", "TOTAL", "ESTADO"]
        ];
        
        state.gridGuides.forEach((g, idx) => {
            const rowNum = idx + 4; // row index in Excel (1-based, starts at 4)
            const price = g.product_price || 0;
            
            aoa.push([
                g.guide_date,
                parseInt(g.guide_number) || g.guide_number,
                g.client_name || "",
                g.project || "",
                g.resident || "",
                g.purchase_order || "",
                g.recompra || "",
                g.plate_code || "",
                g.driver_name || "",
                g.product_name || "",
                g.quantity,
                g.unit,
                price,
                { f: `K${rowNum}*M${rowNum}` }, // Column K is CANT, Column M is PRECIO
                g.billing_status || ""
            ]);
        });
        
        ws = XLSX.utils.aoa_to_sheet(aoa);
        ws['!merges'] = [
            { s: { r: 0, c: 0 }, e: { r: 0, c: 7 } }
        ];
    }
    
    // Auto width adjustments
    const colWidths = [
        { wch: 12 }, // FECHA
        { wch: 10 }, // GUIA
        { wch: 10 }, // PLACA
        { wch: 8 },  // UNI
        { wch: 10 }, // CANT
        { wch: 12 }, // PRECIO / TRANSPORTE
        { wch: 12 }, // TOTAL / PRECIO
        { wch: 15 }, // TOTAL
        { wch: 25 }, // MATERIAL
        { wch: 15 }, // RESI / FACT
        { wch: 15 }, // OBRA / ESTADO
        { wch: 10 }, // OC
        { wch: 10 }, // RC
        { wch: 10 }, // FACT
        { wch: 10 }  // EH/G
    ];
    ws['!cols'] = colWidths;

    XLSX.utils.book_append_sheet(wb, ws, "Reporte");
    XLSX.writeFile(wb, filename);
}

function exportGridToPDF() {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF('l', 'mm', 'a4'); // Landscape

    doc.setFont("Helvetica", "bold");
    doc.setFontSize(16);
    doc.text("TRANSJULCAMP S.A.", 14, 15);
    
    doc.setFont("Helvetica", "normal");
    doc.setFontSize(11);
    doc.text("Reporte General de Guías de Trabajo y Líneas de Producción", 14, 21);
    doc.text(`Fecha de Reporte: ${new Date().toLocaleDateString()}`, 14, 26);

    const columns = [
        "Fecha", "Guía", "Cliente", "Obra", "Placa", "Chofer", "Producto", "Cant.", "Precio", "Total", "Estado"
    ];

    const rows = state.gridGuides.map(g => [
        formatDateString(g.guide_date),
        g.guide_number,
        g.client_name || '',
        g.project || '',
        g.plate_code || '',
        g.driver_name || '',
        g.product_name || '',
        g.quantity.toFixed(1),
        formatCurrency(g.product_price || 0),
        formatCurrency(g.quantity * (g.product_price || 0)),
        g.billing_status
    ]);

    doc.autoTable({
        head: [columns],
        body: rows,
        startY: 32,
        theme: 'striped',
        headStyles: { fillColor: [21, 27, 44] },
        styles: { fontSize: 8 }
    });

    doc.save(`Reporte_Guias_${new Date().toISOString().slice(0,10)}.pdf`);
}

// ==========================================================================
// MODULE 4: Aprobaciones & SRI (Ecuador E-Billing)
// ==========================================================================

function initApprovalsModule() {
    // Setup Modal SRI RIDE buttons
    document.getElementById("btn-close-ride-modal").addEventListener("click", closeRideModal);
    document.getElementById("btn-close-ride-modal-footer").addEventListener("click", closeRideModal);
    
    document.getElementById("btn-ride-pdf-tab").addEventListener("click", () => switchRideModalTab("ride-pdf"));
    document.getElementById("btn-ride-xml-tab").addEventListener("click", () => switchRideModalTab("ride-xml"));
    
    document.getElementById("btn-print-ride").addEventListener("click", () => {
        window.print();
    });

    document.getElementById("btn-download-xml").addEventListener("click", downloadXML);

    // Setup Edit Invoice Modal buttons
    document.getElementById("btn-close-edit-invoice-modal").addEventListener("click", closeEditInvoiceModal);
    document.getElementById("btn-cancel-edit-invoice-modal").addEventListener("click", closeEditInvoiceModal);
    document.getElementById("form-edit-invoice").addEventListener("submit", handleInvoiceEditSave);

    // Reactive Edit Invoice Calculations
    const subtotalInput = document.getElementById("edit-invoice-subtotal");
    const ivaRateInput = document.getElementById("edit-invoice-iva-rate");
    const ivaInput = document.getElementById("edit-invoice-iva");
    const totalInput = document.getElementById("edit-invoice-total");

    const recalculateEditInvoice = () => {
        const subtotal = parseFloat(subtotalInput.value) || 0.0;
        const ivaRate = parseFloat(ivaRateInput.value) || 0.0;
        const iva = subtotal * (ivaRate / 100.0);
        const total = subtotal + iva;
        
        ivaInput.value = iva.toFixed(2);
        totalInput.value = total.toFixed(2);
    };

    subtotalInput.addEventListener("input", recalculateEditInvoice);
    ivaRateInput.addEventListener("input", recalculateEditInvoice);
}

function renderApprovalsTables() {
    // Render Supervisor Approvals Table
    const approvalTbody = document.getElementById("tbl-approval-body");
    approvalTbody.innerHTML = "";
    
    const drafts = state.invoices.filter(i => i.approval_status === "Pendiente");
    if (drafts.length === 0) {
        approvalTbody.innerHTML = '<tr><td colspan="10" class="text-center text-muted">No hay facturas pendientes de aprobación.</td></tr>';
    } else {
        drafts.forEach(inv => {
            const tr = document.createElement("tr");
            const role = sessionStorage.getItem("role");
            
            let actionsHtml = `<button class="btn btn-outline btn-sm" onclick="openEditInvoiceModal(${inv.id})"><i class="fa-solid fa-pen"></i> Editar</button>`;
            
            if (role === "Admin" || role === "Supervisor") {
                actionsHtml += `
                    <button class="btn btn-emerald btn-sm" onclick="handleInvoiceApproval(${inv.id}, 'Aprobada')"><i class="fa-solid fa-check"></i> Aprobar</button>
                    <button class="btn btn-danger btn-sm" onclick="handleInvoiceRejection(${inv.id})"><i class="fa-solid fa-xmark"></i> Rechazar</button>
                `;
            }
            
            if (role === "Admin" || role === "Facturador") {
                actionsHtml += `<button class="btn btn-danger btn-sm" onclick="handleInvoiceDelete(${inv.id})"><i class="fa-solid fa-trash"></i> Eliminar</button>`;
            }

            tr.innerHTML = `
                <td><strong>FACT-${inv.id}</strong></td>
                <td>${formatDateString(inv.invoice_date)}</td>
                <td><strong>${inv.client_name}</strong></td>
                <td class="text-right">${formatCurrency(inv.subtotal)}</td>
                <td class="text-center">${inv.iva_percentage}%</td>
                <td class="text-right">${formatCurrency(inv.iva)}</td>
                <td class="text-right font-weight-bold">${formatCurrency(inv.total)}</td>
                <td class="text-center"><span class="status-badge warning">${inv.approval_status}</span></td>
                <td class="text-center"><span class="status-badge info">${inv.sri_status}</span></td>
                <td>
                    <div style="display:flex; gap:6px; flex-wrap:wrap;">
                        ${actionsHtml}
                    </div>
                </td>
            `;
            approvalTbody.appendChild(tr);
        });
    }

    // Render SRI Emisión Table
    const sriTbody = document.getElementById("tbl-sri-body");
    sriTbody.innerHTML = "";

    const approvedInvoices = state.invoices.filter(i => i.approval_status === "Aprobada");
    if (approvedInvoices.length === 0) {
        sriTbody.innerHTML = '<tr><td colspan="10" class="text-center text-muted">No hay facturas listas para emitir al SRI.</td></tr>';
    } else {
        approvedInvoices.forEach(inv => {
            const tr = document.createElement("tr");
            
            let btnAction = "";
            if (inv.sri_status === "Pendiente de Emisión") {
                btnAction = `<button class="btn btn-primary btn-sm" onclick="emitSRIInvoice(${inv.id})"><i class="fa-solid fa-paper-plane"></i> Enviar SRI</button>`;
            } else {
                btnAction = `<button class="btn btn-outline btn-sm" onclick="viewRIDE(${inv.id})"><i class="fa-solid fa-eye"></i> Ver RIDE / XML</button>`;
            }

            tr.innerHTML = `
                <td><strong>FACT-${inv.id}</strong></td>
                <td>${formatDateString(inv.invoice_date)}</td>
                <td><strong>${inv.client_name}</strong></td>
                <td class="text-right">${formatCurrency(inv.subtotal)}</td>
                <td class="text-right">${formatCurrency(inv.iva)}</td>
                <td class="text-right font-weight-bold">${formatCurrency(inv.total)}</td>
                <td class="text-center"><span class="status-badge success">${inv.approval_status}</span></td>
                <td class="text-center"><span class="status-badge ${inv.sri_status === 'Autorizada' ? 'success' : 'warning'}">${inv.sri_status}</span></td>
                <td><small class="text-muted" style="font-family:monospace;">${inv.sri_access_key || '--'}</small></td>
                <td>${btnAction}</td>
            `;
            sriTbody.appendChild(tr);
        });
    }
}

async function handleInvoiceApproval(id, status) {
    if (!confirm(`¿Está seguro de APROBAR la factura FACT-${id}?`)) return;
    try {
        await fetchAPI(`/invoices/${id}/status`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ approval_status: status })
        });
        alert(`Factura FACT-${id} aprobada con éxito.`);
        await refreshAllData();
        renderApprovalsTables();
    } catch (err) {
        alert(err.message);
    }
}

async function handleInvoiceRejection(id) {
    const reason = prompt("Ingrese el motivo del rechazo de la factura:");
    if (reason === null) return; // cancel
    if (!reason.trim()) {
        alert("El motivo de rechazo es obligatorio.");
        return;
    }

    try {
        await fetchAPI(`/invoices/${id}/status`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ approval_status: "Rechazada", rejection_reason: reason })
        });
        alert(`Factura FACT-${id} rechazada.`);
        await refreshAllData();
        renderApprovalsTables();
    } catch (err) {
        alert(err.message);
    }
}

function openEditInvoiceModal(id) {
    const inv = state.invoices.find(i => i.id === id);
    if (!inv) return;
    
    // Repopulate client selector to make sure it is updated
    populateDropdowns();
    
    document.getElementById("edit-invoice-id").value = inv.id;
    document.getElementById("edit-invoice-client").value = inv.client_id;
    document.getElementById("edit-invoice-date").value = inv.invoice_date;
    document.getElementById("edit-invoice-subtotal").value = inv.subtotal.toFixed(2);
    document.getElementById("edit-invoice-iva-rate").value = inv.iva_percentage.toFixed(2);
    document.getElementById("edit-invoice-iva").value = inv.iva.toFixed(2);
    document.getElementById("edit-invoice-total").value = inv.total.toFixed(2);
    
    document.getElementById("modal-edit-invoice").style.display = "flex";
}

function closeEditInvoiceModal() {
    document.getElementById("modal-edit-invoice").style.display = "none";
    document.getElementById("form-edit-invoice").reset();
}

async function handleInvoiceEditSave(e) {
    e.preventDefault();
    const id = document.getElementById("edit-invoice-id").value;
    
    const payload = {
        client_id: parseInt(document.getElementById("edit-invoice-client").value),
        invoice_date: document.getElementById("edit-invoice-date").value,
        subtotal: parseFloat(document.getElementById("edit-invoice-subtotal").value || 0),
        iva_percentage: parseFloat(document.getElementById("edit-invoice-iva-rate").value || 0),
        iva: parseFloat(document.getElementById("edit-invoice-iva").value || 0),
        total: parseFloat(document.getElementById("edit-invoice-total").value || 0)
    };

    try {
        await fetchAPI(`/invoices/${id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        
        alert("Factura borrador actualizada con éxito.");
        closeEditInvoiceModal();
        await refreshAllData();
        renderApprovalsTables();
    } catch (err) {
        alert(`Error al guardar cambios: ${err.message}`);
    }
}

async function handleInvoiceDelete(id) {
    if (!confirm(`¿Está seguro de ELIMINAR la factura FACT-${id}? Las guías asociadas volverán a estar disponibles para facturar.`)) return;
    try {
        await fetchAPI(`/invoices/${id}`, {
            method: "DELETE"
        });
        alert(`Factura FACT-${id} eliminada con éxito.`);
        await refreshAllData();
        renderApprovalsTables();
    } catch (err) {
        alert(`Error al eliminar factura: ${err.message}`);
    }
}


// Global modal content holder for download
let activeXMLContent = "";

async function emitSRIInvoice(id) {
    try {
        const res = await fetchAPI(`/invoices/${id}/emit-sri`, { method: "POST" });
        alert("Comprobante Autorizado por el SRI de Ecuador exitosamente.");
        activeXMLContent = res.xml;
        
        await refreshAllData();
        renderApprovalsTables();
        
        // Show RIDE
        openRIDEModal(id, res.xml);
    } catch (err) {
        alert(`Error del SRI: ${err.message}`);
    }
}

async function viewRIDE(id) {
    try {
        const res = await fetchAPI(`/invoices/${id}/emit-sri`, { method: "POST" }); // will return already created
        activeXMLContent = res.xml;
        openRIDEModal(id, res.xml);
    } catch (err) {
        alert(err.message);
    }
}

function openRIDEModal(id, xml) {
    // Fetch detail data from local cache
    fetchAPI(`/invoices/${id}`).then(res => {
        const inv = res.invoice;
        const guides = res.guides;

        // Fill RIDE layouts
        document.getElementById("ride-invoice-sec").textContent = String(inv.id).zfill(9);
        document.getElementById("ride-auth-key-title").textContent = inv.sri_access_key || 'PENDIENTE';
        document.getElementById("ride-auth-key-footer").textContent = inv.sri_access_key || 'PENDIENTE';
        document.getElementById("ride-auth-date").textContent = formatDateString(inv.invoice_date) + " 10:15:30 (Simulado)";
        
        document.getElementById("ride-client-name").textContent = inv.client_name;
        document.getElementById("ride-client-ruc").textContent = inv.client_ruc;
        document.getElementById("ride-invoice-date").textContent = formatDateString(inv.invoice_date);
        document.getElementById("ride-client-address").textContent = inv.client_address || '--';

        document.getElementById("ride-extra-address").textContent = inv.client_address || '--';
        document.getElementById("ride-extra-email").textContent = inv.client_email || '--';
        document.getElementById("ride-extra-phone").textContent = inv.client_phone || '--';

        // Load details table
        const tbody = document.getElementById("ride-table-body");
        tbody.innerHTML = "";
        
        guides.forEach(g => {
            const tr = document.createElement("tr");
            const price = g.product_price || 0.0;
            const total = g.quantity * price;
            
            tr.innerHTML = `
                <td>${g.product_id}</td>
                <td>${g.quantity.toFixed(1)}</td>
                <td>${g.product_name} - Obra: ${g.project || ''}</td>
                <td class="text-right">${formatCurrency(price)}</td>
                <td class="text-right">0.00</td>
                <td class="text-right">${formatCurrency(total)}</td>
            `;
            tbody.appendChild(tr);
        });

        // Load Totales
        document.getElementById("ride-subtotal").textContent = formatCurrency(inv.subtotal);
        document.getElementById("ride-subtotal-sin-imp").textContent = formatCurrency(inv.subtotal);
        document.getElementById("ride-iva").textContent = formatCurrency(inv.iva);
        document.getElementById("ride-total").textContent = formatCurrency(inv.total);

        // Load XML tab content
        document.getElementById("xml-content").textContent = xml;

        // Show Modal
        document.getElementById("modal-ride").classList.add("active");
        switchRideModalTab("ride-pdf");
    });
}

function closeRideModal() {
    document.getElementById("modal-ride").classList.remove("active");
}

function switchRideModalTab(tabName) {
    document.querySelectorAll(".ride-tab-btn").forEach(btn => {
        if (btn.dataset.ridetab === tabName) {
            btn.classList.add("active");
        } else {
            btn.classList.remove("active");
        }
    });

    document.querySelectorAll(".ridetab-panel").forEach(panel => {
        if (panel.id === `ridetab-${tabName}`) {
            panel.classList.add("active");
        } else {
            panel.classList.remove("active");
        }
    });
}

function downloadXML() {
    if (!activeXMLContent) return;
    const blob = new Blob([activeXMLContent], { type: "text/xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Factura_SRI_${new Date().toISOString().slice(0,10)}.xml`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

// ==========================================================================
// MODULE 5: Cobros & Cartera View
// ==========================================================================

function initCollectionsModule() {
    // Setup register payment form modal close triggers
    document.getElementById("btn-close-payment-modal").addEventListener("click", closePaymentModal);
    document.getElementById("btn-cancel-payment-modal").addEventListener("click", closePaymentModal);

    // Handle payment registration submit
    document.getElementById("form-register-payment").addEventListener("submit", handlePaymentSubmit);
}

function renderCollectionsView() {
    // 1. Render portfolio summary
    const portfolioTbody = document.getElementById("tbl-portfolio-body");
    portfolioTbody.innerHTML = "";

    state.contacts.forEach(c => {
        const available = c.credit_limit - c.current_balance;
        const availableClass = available >= 0 ? "text-emerald" : "text-red";
        
        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td><strong>${c.name}</strong><br><small class="text-muted">RUC: ${c.ruc}</small></td>
            <td class="text-right">${formatCurrency(c.credit_limit)}</td>
            <td class="text-right text-red font-weight-bold">${formatCurrency(c.current_balance)}</td>
            <td class="text-right ${availableClass} font-weight-bold">${formatCurrency(available)}</td>
        `;
        portfolioTbody.appendChild(tr);
    });

    // 2. Render invoices payment grid
    const invTbody = document.getElementById("tbl-invoice-payments-body");
    invTbody.innerHTML = "";

    // Show only approved invoices that still have pending balances or are fully paid (to see history)
    const approvedInvs = state.invoices.filter(i => i.approval_status === "Aprobada");
    
    if (approvedInvs.length === 0) {
        invTbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted">No hay facturas aprobadas registradas.</td></tr>';
    } else {
        approvedInvs.forEach(inv => {
            let statusClass = "danger";
            if (inv.payment_status === "Pagada") statusClass = "success";
            else if (inv.payment_status === "Pago Parcial") statusClass = "warning";

            const btnPay = inv.payment_status !== "Pagada" 
                ? `<button class="btn btn-emerald btn-sm" onclick="openPaymentModal(${inv.id}, ${inv.total}, ${inv.amount_pending})"><i class="fa-solid fa-coins"></i> Cobrar</button>` 
                : `<span class="text-emerald"><i class="fa-solid fa-check-double"></i> Pagado</span>`;

            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td><strong>FACT-${inv.id}</strong></td>
                <td>${inv.client_name}</td>
                <td class="text-right font-weight-bold">${formatCurrency(inv.total)}</td>
                <td class="text-right text-emerald">${formatCurrency(inv.amount_paid)}</td>
                <td class="text-right text-red">${formatCurrency(inv.amount_pending)}</td>
                <td class="text-center"><span class="status-badge ${statusClass}">${inv.payment_status}</span></td>
                <td>${btnPay}</td>
            `;
            invTbody.appendChild(tr);
        });
    }
}

function openPaymentModal(id, total, pending) {
    document.getElementById("payment-invoice-id").value = id;
    document.getElementById("payment-modal-total").textContent = formatCurrency(total);
    document.getElementById("payment-modal-pending").textContent = formatCurrency(pending);
    
    // Set default max values in inputs
    const cashInput = document.getElementById("payment-cash");
    cashInput.value = pending.toFixed(2);
    cashInput.max = pending.toFixed(2);
    
    document.getElementById("payment-ret-rent").value = "0.00";
    document.getElementById("payment-ret-iva").value = "0.00";

    document.getElementById("modal-payment").classList.add("active");
}

function closePaymentModal() {
    document.getElementById("modal-payment").classList.remove("active");
}

async function handlePaymentSubmit(e) {
    e.preventDefault();
    const id = parseInt(document.getElementById("payment-invoice-id").value);
    
    const payload = {
        amount_paid: parseFloat(document.getElementById("payment-cash").value || 0),
        withholding_rent: parseFloat(document.getElementById("payment-ret-rent").value || 0),
        withholding_iva: parseFloat(document.getElementById("payment-ret-iva").value || 0)
    };

    try {
        await fetchAPI(`/invoices/${id}/pay`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        
        alert("Cobro y retenciones registradas con éxito en la factura.");
        closePaymentModal();
        await refreshAllData();
        renderCollectionsView();
    } catch (err) {
        alert(`Error al registrar el cobro: ${err.message}`);
    }
}

// ==========================================================================
// MODULE 6: Catálogos & CRUDs (Products, Drivers, Machinery)
// ==========================================================================

function initCataloguesModule() {
    // 1. Reactive Pricing Margins Calculator (Módulo F)
    // Formula: Ganancia (Profit) = Price - Cost
    // Formula: Margin = (Profit / Price) * 100
    const costInput = document.getElementById("prod-cost");
    const marginInput = document.getElementById("prod-margin");
    const profitInput = document.getElementById("prod-profit");
    const priceInput = document.getElementById("prod-price");

    // Dynamic Recalculation logic
    costInput.addEventListener("input", () => {
        const cost = parseFloat(costInput.value) || 0;
        const margin = parseFloat(marginInput.value) || 0;
        
        // Recalculate price and profit based on cost & margin
        if (margin < 100) {
            const price = cost / (1 - margin / 100);
            const profit = price - cost;
            priceInput.value = price.toFixed(2);
            profitInput.value = profit.toFixed(2);
        }
    });

    marginInput.addEventListener("input", () => {
        const cost = parseFloat(costInput.value) || 0;
        const margin = parseFloat(marginInput.value) || 0;
        
        if (margin < 100) {
            const price = cost / (1 - margin / 100);
            const profit = price - cost;
            priceInput.value = price.toFixed(2);
            profitInput.value = profit.toFixed(2);
        }
    });

    priceInput.addEventListener("input", () => {
        const cost = parseFloat(costInput.value) || 0;
        const price = parseFloat(priceInput.value) || 0;
        
        // Recalculate margin and profit based on cost & price
        if (price > 0) {
            const profit = price - cost;
            const margin = (profit / price) * 100;
            profitInput.value = profit.toFixed(2);
            marginInput.value = margin.toFixed(2);
        }
    });

    profitInput.addEventListener("input", () => {
        const cost = parseFloat(costInput.value) || 0;
        const profit = parseFloat(profitInput.value) || 0;
        
        // Recalculate price and margin based on cost & profit
        const price = cost + profit;
        if (price > 0) {
            const margin = (profit / price) * 100;
            priceInput.value = price.toFixed(2);
            marginInput.value = margin.toFixed(2);
        }
    });

    // 2. Submit forms
    document.getElementById("form-product").addEventListener("submit", handleProductSave);
    document.getElementById("btn-prod-reset").addEventListener("click", resetProductForm);

    document.getElementById("form-driver").addEventListener("submit", handleDriverSave);
    document.getElementById("btn-driver-reset").addEventListener("click", resetDriverForm);

    document.getElementById("form-machinery").addEventListener("submit", handleMachinerySave);
    document.getElementById("btn-machinery-reset").addEventListener("click", resetMachineryForm);

    document.getElementById("form-client").addEventListener("submit", handleClientSave);
    document.getElementById("btn-client-reset").addEventListener("click", resetClientForm);
}

function renderCataloguesTables() {
    // Render Products CRUD Table
    const prodTbody = document.getElementById("tbl-products-body");
    prodTbody.innerHTML = "";
    state.products.forEach(p => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td><strong>${p.name}</strong></td>
            <td class="text-right">${formatCurrency(p.cost)}</td>
            <td class="text-right">${p.margin.toFixed(2)}%</td>
            <td class="text-right text-emerald">${formatCurrency(p.profit)}</td>
            <td class="text-right font-weight-bold">${formatCurrency(p.price)}</td>
            <td>
                <div style="display:flex; gap:6px;">
                    <button class="btn btn-outline btn-sm" onclick="editProduct(${p.id})"><i class="fa-solid fa-pen"></i></button>
                    <button class="btn btn-danger btn-sm" onclick="deleteProduct(${p.id})"><i class="fa-solid fa-trash"></i></button>
                </div>
            </td>
        `;
        prodTbody.appendChild(tr);
    });

    // Render Drivers CRUD Table
    const driverTbody = document.getElementById("tbl-drivers-body");
    driverTbody.innerHTML = "";
    state.drivers.forEach(d => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td><strong>${d.name}</strong></td>
            <td>${d.dni}</td>
            <td>${d.phone || '--'}</td>
            <td><span class="status-badge ${d.status === 'Activo' ? 'success' : 'danger'}">${d.status}</span></td>
            <td>
                <div style="display:flex; gap:6px;">
                    <button class="btn btn-outline btn-sm" onclick="editDriver(${d.id})"><i class="fa-solid fa-pen"></i></button>
                    <button class="btn btn-danger btn-sm" onclick="deleteDriver(${d.id})"><i class="fa-solid fa-trash"></i></button>
                </div>
            </td>
        `;
        driverTbody.appendChild(tr);
    });

    // Render Machinery CRUD Table
    const machTbody = document.getElementById("tbl-machinery-body");
    machTbody.innerHTML = "";
    state.machinery.forEach(m => {
        let statusClass = "success";
        if (m.maintenance_status === "Mantenimiento") statusClass = "warning";
        else if (m.maintenance_status === "Reparación") statusClass = "danger";

        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td><strong>${m.plate_code}</strong></td>
            <td>${m.type}</td>
            <td>${m.driver_name || '<span class="text-red">No Asignado</span>'}</td>
            <td class="text-right font-weight-bold">${m.accumulated_hours_km.toFixed(1)} h</td>
            <td><span class="status-badge ${statusClass}">${m.maintenance_status}</span></td>
            <td>
                <div style="display:flex; gap:6px;">
                    <button class="btn btn-outline btn-sm" onclick="editMachinery(${m.id})"><i class="fa-solid fa-pen"></i></button>
                    <button class="btn btn-danger btn-sm" onclick="deleteMachinery(${m.id})"><i class="fa-solid fa-trash"></i></button>
                </div>
            </td>
        `;
        machTbody.appendChild(tr);
    });

    // Render Clients CRUD Table
    const clientTbody = document.getElementById("tbl-clients-body");
    if (clientTbody) {
        clientTbody.innerHTML = "";
        state.contacts.forEach(c => {
            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td><strong>${c.name}</strong></td>
                <td>${c.ruc}</td>
                <td>${c.email}</td>
                <td class="text-right font-weight-bold">${formatCurrency(c.credit_limit)}</td>
                <td class="text-right ${c.current_balance > 0 ? 'text-red font-weight-bold' : ''}">${formatCurrency(c.current_balance)}</td>
                <td>
                    <div style="display:flex; gap:6px;">
                        <button class="btn btn-outline btn-sm" onclick="editClient(${c.id})"><i class="fa-solid fa-pen"></i></button>
                        <button class="btn btn-danger btn-sm" onclick="deleteClient(${c.id})"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </td>
            `;
            clientTbody.appendChild(tr);
        });
    }
}

// PRODUCTS CRUD HANDLERS
async function handleProductSave(e) {
    e.preventDefault();
    const id = document.getElementById("prod-id").value;
    
    const payload = {
        name: document.getElementById("prod-name").value,
        cost: parseFloat(document.getElementById("prod-cost").value || 0),
        margin: parseFloat(document.getElementById("prod-margin").value || 0),
        profit: parseFloat(document.getElementById("prod-profit").value || 0),
        price: parseFloat(document.getElementById("prod-price").value || 0)
    };

    try {
        if (id) {
            await fetchAPI(`/products/${id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });
        } else {
            await fetchAPI("/products", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });
        }
        
        alert("Producto guardado con éxito.");
        resetProductForm();
        await refreshAllData();
        renderCataloguesTables();
    } catch (err) {
        alert(err.message);
    }
}

function editProduct(id) {
    const prod = state.products.find(p => p.id === id);
    if (!prod) return;
    
    document.getElementById("prod-id").value = prod.id;
    document.getElementById("prod-name").value = prod.name;
    document.getElementById("prod-cost").value = prod.cost.toFixed(2);
    document.getElementById("prod-margin").value = prod.margin.toFixed(2);
    document.getElementById("prod-profit").value = prod.profit.toFixed(2);
    document.getElementById("prod-price").value = prod.price.toFixed(2);

    document.getElementById("product-form-title").textContent = "Editar Producto/Servicio";
}

async function deleteProduct(id) {
    if (!confirm("¿Está seguro de eliminar este producto?")) return;
    try {
        await fetchAPI(`/products/${id}`, { method: "DELETE" });
        await refreshAllData();
        renderCataloguesTables();
    } catch (err) {
        alert(err.message);
    }
}

function resetProductForm() {
    document.getElementById("prod-id").value = "";
    document.getElementById("form-product").reset();
    document.getElementById("product-form-title").textContent = "Agregar Nuevo Producto/Servicio";
}

// DRIVERS CRUD HANDLERS
async function handleDriverSave(e) {
    e.preventDefault();
    const id = document.getElementById("driver-id-input").value;
    
    const payload = {
        name: document.getElementById("driver-name-input").value,
        dni: document.getElementById("driver-dni").value,
        phone: document.getElementById("driver-phone").value,
        address: document.getElementById("driver-address").value,
        status: document.getElementById("driver-status-input").value
    };

    try {
        if (id) {
            await fetchAPI(`/drivers/${id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });
        } else {
            await fetchAPI("/drivers", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });
        }
        
        alert("Chofer guardado con éxito.");
        resetDriverForm();
        await refreshAllData();
        renderCataloguesTables();
    } catch (err) {
        alert(err.message);
    }
}

function editDriver(id) {
    const driver = state.drivers.find(d => d.id === id);
    if (!driver) return;
    
    document.getElementById("driver-id-input").value = driver.id;
    document.getElementById("driver-name-input").value = driver.name;
    document.getElementById("driver-dni").value = driver.dni;
    document.getElementById("driver-phone").value = driver.phone || "";
    document.getElementById("driver-address").value = driver.address || "";
    document.getElementById("driver-status-input").value = driver.status;

    document.getElementById("driver-form-title").textContent = "Editar Chofer";
}

async function deleteDriver(id) {
    if (!confirm("¿Está seguro de eliminar este chofer?")) return;
    try {
        await fetchAPI(`/drivers/${id}`, { method: "DELETE" });
        await refreshAllData();
        renderCataloguesTables();
    } catch (err) {
        alert(err.message);
    }
}

function resetDriverForm() {
    document.getElementById("driver-id-input").value = "";
    document.getElementById("form-driver").reset();
    document.getElementById("driver-form-title").textContent = "Agregar Nuevo Chofer";
}

// MACHINERY CRUD HANDLERS
async function handleMachinerySave(e) {
    e.preventDefault();
    const id = document.getElementById("machinery-id-input").value;
    
    const payload = {
        plate_code: document.getElementById("machinery-plate").value,
        type: document.getElementById("machinery-type").value,
        driver_id: document.getElementById("machinery-driver").value ? parseInt(document.getElementById("machinery-driver").value) : null,
        accumulated_hours_km: parseFloat(document.getElementById("machinery-hours").value || 0),
        maintenance_status: document.getElementById("machinery-status").value
    };

    try {
        if (id) {
            await fetchAPI(`/machinery/${id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });
        } else {
            await fetchAPI("/machinery", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });
        }
        
        alert("Maquinaria guardada con éxito.");
        resetMachineryForm();
        await refreshAllData();
        renderCataloguesTables();
    } catch (err) {
        alert(err.message);
    }
}

function editMachinery(id) {
    const mach = state.machinery.find(m => m.id === id);
    if (!mach) return;
    
    document.getElementById("machinery-id-input").value = mach.id;
    document.getElementById("machinery-plate").value = mach.plate_code;
    document.getElementById("machinery-type").value = mach.type;
    document.getElementById("machinery-driver").value = mach.driver_id || "";
    document.getElementById("machinery-hours").value = mach.accumulated_hours_km;
    document.getElementById("machinery-status").value = mach.maintenance_status;

    document.getElementById("machinery-form-title").textContent = "Editar Maquinaria / Volqueta";
}

async function deleteMachinery(id) {
    if (!confirm("¿Está seguro de eliminar este equipo de la flota?")) return;
    try {
        await fetchAPI(`/machinery/${id}`, { method: "DELETE" });
        await refreshAllData();
        renderCataloguesTables();
    } catch (err) {
        alert(err.message);
    }
}

function resetMachineryForm() {
    document.getElementById("machinery-id-input").value = "";
    document.getElementById("form-machinery").reset();
    document.getElementById("machinery-form-title").textContent = "Registrar Nueva Maquinaria / Volqueta";
}

// CLIENTS CRUD HANDLERS
async function handleClientSave(e) {
    e.preventDefault();
    const id = document.getElementById("client-id-input").value;
    
    const payload = {
        name: document.getElementById("client-name-input").value,
        ruc: document.getElementById("client-ruc").value,
        email: document.getElementById("client-email").value,
        phone: document.getElementById("client-phone").value,
        address: document.getElementById("client-address").value,
        credit_limit: parseFloat(document.getElementById("client-credit-limit").value || 0),
        current_balance: parseFloat(document.getElementById("client-balance").value || 0)
    };

    try {
        if (id) {
            await fetchAPI(`/contacts/${id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });
        } else {
            await fetchAPI("/contacts", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });
        }
        
        alert("Cliente guardado con éxito.");
        resetClientForm();
        await refreshAllData();
        renderCataloguesTables();
    } catch (err) {
        alert(err.message);
    }
}

function editClient(id) {
    const client = state.contacts.find(c => c.id === id);
    if (!client) return;
    
    document.getElementById("client-id-input").value = client.id;
    document.getElementById("client-name-input").value = client.name;
    document.getElementById("client-ruc").value = client.ruc;
    document.getElementById("client-email").value = client.email;
    document.getElementById("client-phone").value = client.phone || "";
    document.getElementById("client-address").value = client.address || "";
    document.getElementById("client-credit-limit").value = client.credit_limit.toFixed(2);
    document.getElementById("client-balance").value = client.current_balance.toFixed(2);

    document.getElementById("client-form-title").textContent = "Editar Cliente";
}

async function deleteClient(id) {
    if (!confirm("¿Está seguro de eliminar este cliente?")) return;
    try {
        await fetchAPI(`/contacts/${id}`, { method: "DELETE" });
        await refreshAllData();
        renderCataloguesTables();
    } catch (err) {
        alert(err.message);
    }
}

function resetClientForm() {
    document.getElementById("client-id-input").value = "";
    document.getElementById("form-client").reset();
    document.getElementById("client-form-title").textContent = "Agregar Nuevo Cliente";
}


// ==========================================================================
// MODULE 7: Planificación / Cronograma (Calendario)
// ==========================================================================

function initPlanningModule() {
    // Modal buttons
    document.getElementById("btn-new-schedule").addEventListener("click", () => {
        openNewScheduleModal(state.planningSelectedDateStr);
    });
    document.getElementById("btn-close-schedule-modal").addEventListener("click", closeScheduleModal);
    document.getElementById("btn-cancel-schedule-modal").addEventListener("click", closeScheduleModal);
    
    // Calendar month navigation
    document.getElementById("btn-prev-month").addEventListener("click", () => {
        state.planningMonth--;
        if (state.planningMonth < 0) {
            state.planningMonth = 11;
            state.planningYear--;
        }
        renderPlanningCalendar();
    });
    
    document.getElementById("btn-next-month").addEventListener("click", () => {
        state.planningMonth++;
        if (state.planningMonth > 11) {
            state.planningMonth = 0;
            state.planningYear++;
        }
        renderPlanningCalendar();
    });

    // Form submit
    document.getElementById("form-schedule").addEventListener("submit", handleScheduleFormSubmit);
}

function renderPlanningCalendar() {
    const monthNames = [
        "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
        "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"
    ];
    
    const monthLabel = document.getElementById("calendar-month-year");
    if (monthLabel) {
        monthLabel.textContent = `${monthNames[state.planningMonth]} ${state.planningYear}`;
    }

    const grid = document.getElementById("calendar-grid");
    if (!grid) return;
    grid.innerHTML = "";

    // Day calculations
    const firstDayIndex = new Date(state.planningYear, state.planningMonth, 1).getDay();
    const totalDays = new Date(state.planningYear, state.planningMonth + 1, 0).getDate();
    const prevMonthTotalDays = new Date(state.planningYear, state.planningMonth, 0).getDate();

    // 1. Previous Month Padding days
    for (let i = firstDayIndex - 1; i >= 0; i--) {
        const dayNum = prevMonthTotalDays - i;
        const prevMonth = state.planningMonth === 0 ? 11 : state.planningMonth - 1;
        const prevYear = state.planningMonth === 0 ? state.planningYear - 1 : state.planningYear;
        const dateStr = `${prevYear}-${(prevMonth + 1).toString().padStart(2, '0')}-${dayNum.toString().padStart(2, '0')}`;
        
        const cell = createCalendarDayCell(dayNum, dateStr, true);
        grid.appendChild(cell);
    }

    // 2. Current Month days
    for (let dayNum = 1; dayNum <= totalDays; dayNum++) {
        const dateStr = `${state.planningYear}-${(state.planningMonth + 1).toString().padStart(2, '0')}-${dayNum.toString().padStart(2, '0')}`;
        
        const cell = createCalendarDayCell(dayNum, dateStr, false);
        grid.appendChild(cell);
    }

    // 3. Next Month Padding days
    const totalCellsUsed = firstDayIndex + totalDays;
    const remainingCells = totalCellsUsed % 7 === 0 ? 0 : 7 - (totalCellsUsed % 7);
    for (let dayNum = 1; dayNum <= remainingCells; dayNum++) {
        const nextMonth = state.planningMonth === 11 ? 0 : state.planningMonth + 1;
        const nextYear = state.planningMonth === 11 ? state.planningYear + 1 : state.planningYear;
        const dateStr = `${nextYear}-${(nextMonth + 1).toString().padStart(2, '0')}-${dayNum.toString().padStart(2, '0')}`;
        
        const cell = createCalendarDayCell(dayNum, dateStr, true);
        grid.appendChild(cell);
    }

    // Refresh selected day details panel
    renderDayScheduleList();
}

function createCalendarDayCell(dayNum, dateStr, isOtherMonth) {
    const cell = document.createElement("div");
    cell.className = "calendar-day-cell";
    if (isOtherMonth) cell.classList.add("other-month");
    
    // Check if cell represents today
    const todayStr = new Date().toISOString().slice(0, 10);
    if (dateStr === todayStr) {
        cell.classList.add("today");
    }
    
    // Check if cell is currently selected
    if (dateStr === state.planningSelectedDateStr) {
        cell.classList.add("selected");
    }

    cell.dataset.dateStr = dateStr;

    // Day Number label
    cell.innerHTML = `<span class="day-number">${dayNum}</span>`;

    // Overlapping schedules container
    const eventsContainer = document.createElement("div");
    eventsContainer.className = "calendar-day-events";

    // Find schedules overlapping with this date
    const cellDate = new Date(dateStr + "T00:00:00");
    const daySchedules = state.schedules.filter(s => {
        const start = new Date(s.start_date + "T00:00:00");
        const end = new Date(s.end_date + "T00:00:00");
        return cellDate >= start && cellDate <= end;
    });

    // Draw detailed badges for all events on this day (like Google Calendar)
    daySchedules.forEach((s, idx) => {
        const badge = document.createElement("span");
        badge.className = `compact-event-badge ${idx % 2 === 0 ? '' : 'alternate'}`;
        badge.style.cursor = "pointer";
        
        // Show detailed Driver, Vehicle Plate, and Project
        const driverName = s.driver_name ? s.driver_name.split(' ')[0] : 'S/Chofer'; // show first name
        badge.innerHTML = `<strong>${driverName}</strong> | ${s.plate_code || 'S/P'} | <span>${s.project || 'Gral'}</span>`;
        
        badge.addEventListener("click", (e) => {
            e.stopPropagation(); // prevent opening create modal on cell click
            openEditScheduleModal(s.id);
        });
        eventsContainer.appendChild(badge);
    });

    cell.appendChild(eventsContainer);

    // Event listener to select day and immediately open scheduling form for this date
    cell.addEventListener("click", () => {
        document.querySelectorAll(".calendar-day-cell").forEach(c => c.classList.remove("selected"));
        cell.classList.add("selected");
        state.planningSelectedDateStr = dateStr;
        renderDayScheduleList();
        
        // Open the form pre-populated with this day's date
        openNewScheduleModal(dateStr);
    });

    return cell;
}

function renderDayScheduleList() {
    const label = document.getElementById("selected-date-label");
    if (label) {
        label.textContent = formatDateString(state.planningSelectedDateStr);
    }

    const listContainer = document.getElementById("day-schedule-list");
    if (!listContainer) return;
    listContainer.innerHTML = "";

    const selectedDate = new Date(state.planningSelectedDateStr + "T00:00:00");
    const daySchedules = state.schedules.filter(s => {
        const start = new Date(s.start_date + "T00:00:00");
        const end = new Date(s.end_date + "T00:00:00");
        return selectedDate >= start && selectedDate <= end;
    });

    if (daySchedules.length === 0) {
        listContainer.innerHTML = '<div class="text-center text-muted" style="padding: 20px 0;"><i class="fa-solid fa-calendar-minus" style="font-size: 24px; margin-bottom: 8px;"></i><p>No hay planificaciones programadas para este día.</p></div>';
        return;
    }

    daySchedules.forEach((s, idx) => {
        const card = document.createElement("div");
        card.className = `day-schedule-card ${idx % 2 === 0 ? '' : 'alternate'}`;
        
        card.innerHTML = `
            <h4>${s.project || 'OBRA SIN NOMBRE'}</h4>
            <p><strong>Cliente:</strong> ${s.client_name || 'Sin Cliente'}</p>
            <p><strong>Chofer:</strong> ${s.driver_name || 'Sin Chofer asignado'}</p>
            <p><strong>Vehículo / Placa:</strong> ${s.plate_code || 'Sin Vehículo asignado'}</p>
            <p><strong>Duración:</strong> Desde ${formatDateString(s.start_date)} hasta ${formatDateString(s.end_date)}</p>
            <p><strong>Horas Planificadas:</strong> ${s.planned_hours} horas/día</p>
            ${s.description ? `<p style="font-style: italic; font-size: 11px; margin-top: 6px; color: var(--text-muted);">${s.description}</p>` : ''}
            <div class="schedule-actions">
                <button class="btn btn-outline btn-sm" onclick="openEditScheduleModal(${s.id})"><i class="fa-solid fa-pen-to-square"></i> Editar</button>
                <button class="btn btn-outline btn-sm" style="border-color: rgba(239, 68, 68, 0.4); color: #ef4444;" onclick="deleteScheduleRecord(${s.id})"><i class="fa-solid fa-trash"></i> Eliminar</button>
            </div>
        `;
        listContainer.appendChild(card);
    });
}

function openNewScheduleModal(defaultDateStr) {
    document.getElementById("schedule-modal-title").textContent = "Nueva Planificación";
    document.getElementById("schedule-id").value = "";
    document.getElementById("form-schedule").reset();
    
    // Set default dates
    const dateVal = defaultDateStr || new Date().toISOString().slice(0, 10);
    document.getElementById("schedule-start-date").value = dateVal;
    document.getElementById("schedule-end-date").value = dateVal;
    document.getElementById("schedule-hours").value = "8.0";

    document.getElementById("modal-schedule").classList.add("active");
}

function openEditScheduleModal(id) {
    const s = state.schedules.find(x => x.id === id);
    if (!s) return;

    document.getElementById("schedule-modal-title").textContent = "Editar Planificación";
    document.getElementById("schedule-id").value = s.id;
    document.getElementById("schedule-client").value = s.contact_id || "";
    document.getElementById("schedule-driver").value = s.driver_id || "";
    document.getElementById("schedule-plate").value = s.plate_code || "";
    document.getElementById("schedule-start-date").value = s.start_date;
    document.getElementById("schedule-end-date").value = s.end_date;
    document.getElementById("schedule-hours").value = s.planned_hours;
    document.getElementById("schedule-project").value = s.project || "";
    document.getElementById("schedule-desc").value = s.description || "";

    document.getElementById("modal-schedule").classList.add("active");
}

function closeScheduleModal() {
    document.getElementById("modal-schedule").classList.remove("active");
}

function checkScheduleConflicts(payload, excludeId) {
    const startStr = payload.start_date;
    const endStr = payload.end_date;
    const hNew = payload.planned_hours;
    const driverId = payload.driver_id;
    const plateCode = payload.plate_code;

    // Generate array of date strings between startStr and endStr inclusive
    const dates = [];
    let curr = new Date(startStr + "T00:00:00");
    const end = new Date(endStr + "T00:00:00");
    while (curr <= end) {
        dates.push(curr.toISOString().slice(0, 10));
        curr.setDate(curr.getDate() + 1);
    }

    const conflicts = [];

    // Filter schedules once (excluding the current one we are editing)
    const otherSchedules = state.schedules.filter(s => String(s.id) !== String(excludeId));

    for (const dateStr of dates) {
        const checkDate = new Date(dateStr + "T00:00:00");

        // Helper to check if a schedule overlaps with checkDate
        const overlaps = (s) => {
            const sStart = new Date(s.start_date + "T00:00:00");
            const sEnd = new Date(s.end_date + "T00:00:00");
            return checkDate >= sStart && checkDate <= sEnd;
        };

        // 1. Check Driver
        if (driverId) {
            const driverSchedules = otherSchedules.filter(s => s.driver_id === driverId && overlaps(s));
            const existingHours = driverSchedules.reduce((sum, s) => sum + (s.planned_hours || 0), 0);
            const totalHours = existingHours + hNew;
            if (totalHours > 8.0) {
                const driverName = state.drivers.find(d => d.id === driverId)?.name || "Chofer";
                const crossProjects = driverSchedules.map(s => s.project || "Obra").join(", ");
                conflicts.push(`Chofer "${driverName}" acumularía ${totalHours.toFixed(1)}h el día ${formatDateString(dateStr)} (Cruza con obra: "${crossProjects}")`);
            }
        }

        // 2. Check Plate
        if (plateCode) {
            const plateSchedules = otherSchedules.filter(s => s.plate_code === plateCode && overlaps(s));
            const existingHours = plateSchedules.reduce((sum, s) => sum + (s.planned_hours || 0), 0);
            const totalHours = existingHours + hNew;
            if (totalHours > 8.0) {
                const crossProjects = plateSchedules.map(s => s.project || "Obra").join(", ");
                conflicts.push(`Vehículo/Placa "${plateCode}" acumularía ${totalHours.toFixed(1)}h el día ${formatDateString(dateStr)} (Cruza con obra: "${crossProjects}")`);
            }
        }
    }

    return conflicts;
}

async function handleScheduleFormSubmit(e) {
    e.preventDefault();

    const id = document.getElementById("schedule-id").value;
    const payload = {
        contact_id: parseInt(document.getElementById("schedule-client").value) || null,
        driver_id: parseInt(document.getElementById("schedule-driver").value) || null,
        plate_code: document.getElementById("schedule-plate").value || null,
        start_date: document.getElementById("schedule-start-date").value,
        end_date: document.getElementById("schedule-end-date").value,
        planned_hours: parseFloat(document.getElementById("schedule-hours").value) || 0.0,
        project: document.getElementById("schedule-project").value || "",
        description: document.getElementById("schedule-desc").value || ""
    };

    // Check conflicts
    const conflicts = checkScheduleConflicts(payload, id);
    if (conflicts.length > 0) {
        const warningMsg = `¡ADVERTENCIA DE CRUCE DE DIAS / HORAS (SUPERANDO 8 HORAS)!\n\n` + 
                           conflicts.slice(0, 5).join("\n\n") + 
                           (conflicts.length > 5 ? `\n\n... y ${conflicts.length - 5} cruces más.` : "") + 
                           `\n\n¿Está seguro de que desea guardar esta planificación de todos modos?`;
        
        if (!confirm(warningMsg)) {
            return; // Abort saving
        }
    }

    try {
        if (id) {
            // Edit
            await fetchAPI(`/schedules/${id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });
        } else {
            // Create
            await fetchAPI("/schedules", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });
        }
        
        closeScheduleModal();
        await refreshAllData();
        renderPlanningCalendar();
    } catch (err) {
        alert(err.message);
    }
}

async function deleteScheduleRecord(id) {
    if (!confirm("¿Está seguro de eliminar este registro de planificación?")) return;
    try {
        await fetchAPI(`/schedules/${id}`, { method: "DELETE" });
        await refreshAllData();
        renderPlanningCalendar();
    } catch (err) {
        alert(err.message);
    }
}


// ==========================================================================
// STRING FORMATTERS & PROTOTYPES
// ==========================================================================

function formatCurrency(val) {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(val);
}

function formatDateString(dateStr) {
    if (!dateStr) return '--';
    const parts = dateStr.split('-');
    if (parts.length === 3) {
        return `${parts[2]}/${parts[1]}/${parts[0]}`;
    }
    return dateStr;
}

// String zfill helper (equivalent to Python's zfill)
String.prototype.zfill = function(size) {
    let s = this;
    while (s.length < size) s = "0" + s;
    return s;
};

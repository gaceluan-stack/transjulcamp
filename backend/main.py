import os
import shutil
import sqlite3
import random
import psycopg2
from datetime import datetime
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Depends, Header, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import List, Optional

from backend.database import get_connection, init_db
from backend.ocr import analyze_guide_image

DBIntegrityError = (sqlite3.IntegrityError, psycopg2.IntegrityError)

class LoginSchema(BaseModel):
    username: str
    password: str


# Initialize Database
init_db()

app = FastAPI(title="Transjulcamp API", version="1.0.0")

# CORS setup
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

UPLOAD_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "uploads")
if not os.path.exists(UPLOAD_DIR):
    os.makedirs(UPLOAD_DIR)

# Helper function to convert SQLite Row to Dict
def to_dict(row):
    return dict(row) if row else None

# Pydantic Schemas for validation
class ContactSchema(BaseModel):
    name: str
    ruc: str
    address: Optional[str] = ""
    phone: Optional[str] = ""
    email: Optional[str] = ""
    credit_limit: float = 0.0
    current_balance: float = 0.0

class DriverSchema(BaseModel):
    name: str
    dni: str
    phone: Optional[str] = ""
    address: Optional[str] = ""
    status: str = "Activo"

class MachinerySchema(BaseModel):
    plate_code: str
    type: str
    driver_id: Optional[int] = None
    accumulated_hours_km: float = 0.0
    maintenance_status: str = "Operativo"

class ProductSchema(BaseModel):
    name: str
    cost: float
    margin: float
    profit: float
    price: float

class GuideSaveSchema(BaseModel):
    guide_number: str
    guide_date: str
    description: Optional[str] = ""
    quantity: float
    unit: str
    project: Optional[str] = ""
    contact_id: Optional[int] = None
    plate_code: Optional[str] = None
    product_id: Optional[int] = None
    driver_id: Optional[int] = None
    signature_detected: int = 0
    hours_worked: float = 0.0
    purchase_order: Optional[str] = ""
    recompra: Optional[str] = ""
    resident: Optional[str] = ""

class ScheduleSchema(BaseModel):
    driver_id: Optional[int] = None
    plate_code: Optional[str] = None
    start_date: str
    end_date: str
    planned_hours: float = 0.0
    project: Optional[str] = ""
    contact_id: Optional[int] = None
    description: Optional[str] = ""

class InvoiceGenerateSchema(BaseModel):
    guide_ids: List[int]
    iva_percentage: float = 15.0

class InvoiceUpdateSchema(BaseModel):
    client_id: int
    invoice_date: str
    subtotal: float
    iva_percentage: float
    iva: float
    total: float

class PaymentSchema(BaseModel):
    amount_paid: float
    withholding_rent: float = 0.0
    withholding_iva: float = 0.0

# Security Middleware and Roles Check
@app.middleware("http")
async def db_session_middleware(request: Request, call_next):
    path = request.url.path
    if path.startswith("/api") and path != "/api/login" and request.method != "OPTIONS":
        auth_header = request.headers.get("Authorization")
        if not auth_header or not auth_header.startswith("Bearer "):
            from fastapi.responses import JSONResponse
            return JSONResponse(status_code=401, content={"detail": "No autorizado. Inicie sesión."})
        token = auth_header.split(" ")[1]
        
        if not token.startswith("mock-token-"):
            from fastapi.responses import JSONResponse
            return JSONResponse(status_code=401, content={"detail": "Token de sesión inválido."})
            
        parts = token.replace("mock-token-", "").split("-")
        if len(parts) != 2:
            from fastapi.responses import JSONResponse
            return JSONResponse(status_code=401, content={"detail": "Token corrupto."})
            
        username, role = parts[0], parts[1]
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM users WHERE username = ? AND role = ?", (username, role))
        user = cursor.fetchone()
        conn.close()
        
        if not user:
            from fastapi.responses import JSONResponse
            return JSONResponse(status_code=401, content={"detail": "Usuario no encontrado o rol incorrecto."})
            
        request.state.user = {"username": user["username"], "role": user["role"]}
        
        # Enforce Role-Based Access Control (RBAC)
        role = user["role"]
        method = request.method
        
        # 1. Block catalog modifications for Supervisor and Facturador (only Admin allowed)
        is_catalog_write = False
        catalog_paths = ["/api/contacts", "/api/drivers", "/api/machinery", "/api/products"]
        for cp in catalog_paths:
            if path.startswith(cp):
                if method in ["POST", "PUT", "DELETE"]:
                    is_catalog_write = True
                    break
                    
        if is_catalog_write and role != "Admin":
            from fastapi.responses import JSONResponse
            return JSONResponse(status_code=403, content={"detail": "Acceso denegado. Permisos insuficientes (Solo Admin)."})
            
        # 2. Block payment (Cobros) for Supervisor
        if path.startswith("/api/invoices/") and path.endswith("/pay") and role == "Supervisor":
            from fastapi.responses import JSONResponse
            return JSONResponse(status_code=403, content={"detail": "Acceso denegado. Supervisor no puede registrar cobros."})
            
        # 3. Block status updates (Approvals) for Facturador
        if path.startswith("/api/invoices/") and path.endswith("/status") and role == "Facturador":
            from fastapi.responses import JSONResponse
            return JSONResponse(status_code=403, content={"detail": "Acceso denegado. Facturador no puede aprobar/rechazar facturas."})
            
        # 4. Block SRI emissions for Supervisor
        if path.startswith("/api/invoices/") and path.endswith("/emit-sri") and role == "Supervisor":
            from fastapi.responses import JSONResponse
            return JSONResponse(status_code=403, content={"detail": "Acceso denegado. Supervisor no puede emitir al SRI."})

    response = await call_next(request)
    return response

@app.get("/health")
def health_check():
    return {"status": "healthy", "service": "transjulcamp"}

# --- AUTH ENDPOINTS ---

@app.post("/api/login")
def login(payload: LoginSchema):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM users WHERE username = ? AND password = ?", (payload.username, payload.password))
    user = cursor.fetchone()
    conn.close()
    
    if not user:
        raise HTTPException(status_code=400, detail="Usuario o contraseña incorrectos.")
        
    token = f"mock-token-{user['username']}-{user['role']}"
    return {
        "token": token,
        "username": user["username"],
        "role": user["role"]
    }

@app.get("/api/me")
def get_me(request: Request):
    if not hasattr(request.state, "user"):
        raise HTTPException(status_code=401, detail="No autenticado.")
    return request.state.user


# --- API ENDPOINTS ---

# 1. Dashboard Metrics
@app.get("/api/dashboard/kpis")
def get_dashboard_kpis():
    conn = get_connection()
    cursor = conn.cursor()
    try:
        # Total Billed
        cursor.execute("SELECT SUM(total) FROM invoices WHERE approval_status = 'Aprobada'")
        total_billed = cursor.fetchone()[0] or 0.0

        # Cartera por Cobrar (Pending collections)
        cursor.execute("SELECT SUM(amount_pending) FROM invoices WHERE approval_status = 'Aprobada'")
        total_pending = cursor.fetchone()[0] or 0.0

        # Active Machinery
        cursor.execute("SELECT COUNT(*) FROM machinery WHERE maintenance_status = 'Operativo'")
        active_machinery = cursor.fetchone()[0] or 0

        # Unbilled Guides
        cursor.execute("SELECT COUNT(*) FROM work_guides WHERE billing_status = 'Pendiente'")
        unbilled_guides = cursor.fetchone()[0] or 0

        # Outstanding per Client (Top 5)
        cursor.execute("""
            SELECT c.name, SUM(i.amount_pending) as pending
            FROM invoices i
            JOIN contacts c ON i.client_id = c.id
            WHERE i.approval_status = 'Aprobada' AND i.payment_status != 'Pagada'
            GROUP BY c.id
            ORDER BY pending DESC
            LIMIT 5
        """)
        top_debtors = [dict(row) for row in cursor.fetchall()]

        return {
            "total_billed": total_billed,
            "total_pending": total_pending,
            "active_machinery": active_machinery,
            "unbilled_guides": unbilled_guides,
            "top_debtors": top_debtors
        }
    finally:
        conn.close()

@app.get("/api/dashboard/charts")
def get_dashboard_charts():
    conn = get_connection()
    cursor = conn.cursor()
    try:
        # Trips / Work hours per driver
        cursor.execute("""
            SELECT d.name, SUM(g.quantity) as total_work
            FROM work_guides g
            JOIN drivers d ON g.driver_id = d.id
            GROUP BY d.id
        """)
        driver_productivity = [dict(row) for row in cursor.fetchall()]

        # Machinery productivity (hours worked vs maintenance cost approximation)
        cursor.execute("""
            SELECT plate_code, type, accumulated_hours_km,
            (SELECT COUNT(*) FROM work_guides WHERE plate_code = m.plate_code) as total_jobs
            FROM machinery m
        """)
        machinery_productivity = [dict(row) for row in cursor.fetchall()]

        # Revenue generated per vehicle/plate
        cursor.execute("""
            SELECT g.plate_code, SUM(g.quantity * p.price) as revenue
            FROM work_guides g
            JOIN products p ON g.product_id = p.id
            GROUP BY g.plate_code
            ORDER BY revenue DESC
        """)
        revenue_per_vehicle = [dict(row) for row in cursor.fetchall()]

        return {
            "driver_productivity": driver_productivity,
            "machinery_productivity": machinery_productivity,
            "revenue_per_vehicle": revenue_per_vehicle
        }
    finally:
        conn.close()


# 2. Contacts CRUD
@app.get("/api/contacts")
def get_contacts():
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM contacts ORDER BY name ASC")
    rows = cursor.fetchall()
    conn.close()
    return [to_dict(r) for r in rows]

@app.post("/api/contacts")
def create_contact(contact: ContactSchema):
    conn = get_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("""
        INSERT INTO contacts (name, ruc, address, phone, email, credit_limit, current_balance)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (contact.name, contact.ruc, contact.address, contact.phone, contact.email, contact.credit_limit, contact.current_balance))
        conn.commit()
        contact_id = cursor.lastrowid
        return {"id": contact_id, "message": "Contact created successfully"}
    except DBIntegrityError:
        raise HTTPException(status_code=400, detail="RUC/Cédula already exists.")
    finally:
        conn.close()

@app.put("/api/contacts/{id}")
def update_contact(id: int, contact: ContactSchema):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
    UPDATE contacts
    SET name=?, ruc=?, address=?, phone=?, email=?, credit_limit=?, current_balance=?
    WHERE id=?
    """, (contact.name, contact.ruc, contact.address, contact.phone, contact.email, contact.credit_limit, contact.current_balance, id))
    conn.commit()
    conn.close()
    return {"message": "Contact updated successfully"}

@app.delete("/api/contacts/{id}")
def delete_contact(id: int):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM contacts WHERE id=?", (id,))
    conn.commit()
    conn.close()
    return {"message": "Contact deleted successfully"}


# 3. Drivers CRUD
@app.get("/api/drivers")
def get_drivers():
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM drivers ORDER BY name ASC")
    rows = cursor.fetchall()
    conn.close()
    return [to_dict(r) for r in rows]

@app.post("/api/drivers")
def create_driver(driver: DriverSchema):
    conn = get_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("""
        INSERT INTO drivers (name, dni, phone, address, status)
        VALUES (?, ?, ?, ?, ?)
        """, (driver.name, driver.dni, driver.phone, driver.address, driver.status))
        conn.commit()
        return {"id": cursor.lastrowid, "message": "Driver created successfully"}
    except DBIntegrityError:
        raise HTTPException(status_code=400, detail="DNI already exists.")
    finally:
        conn.close()

@app.put("/api/drivers/{id}")
def update_driver(id: int, driver: DriverSchema):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
    UPDATE drivers
    SET name=?, dni=?, phone=?, address=?, status=?
    WHERE id=?
    """, (driver.name, driver.dni, driver.phone, driver.address, driver.status, id))
    conn.commit()
    conn.close()
    return {"message": "Driver updated successfully"}

@app.delete("/api/drivers/{id}")
def delete_driver(id: int):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM drivers WHERE id=?", (id,))
    conn.commit()
    conn.close()
    return {"message": "Driver deleted successfully"}


# 4. Machinery CRUD
@app.get("/api/machinery")
def get_machinery():
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT m.*, d.name as driver_name 
        FROM machinery m 
        LEFT JOIN drivers d ON m.driver_id = d.id
        ORDER BY plate_code ASC
    """)
    rows = cursor.fetchall()
    conn.close()
    return [to_dict(r) for r in rows]

@app.post("/api/machinery")
def create_machinery(m: MachinerySchema):
    conn = get_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("""
        INSERT INTO machinery (plate_code, type, driver_id, accumulated_hours_km, maintenance_status)
        VALUES (?, ?, ?, ?, ?)
        """, (m.plate_code, m.type, m.driver_id, m.accumulated_hours_km, m.maintenance_status))
        conn.commit()
        return {"id": cursor.lastrowid, "message": "Machinery created successfully"}
    except DBIntegrityError:
        raise HTTPException(status_code=400, detail="Plate code already exists.")
    finally:
        conn.close()

@app.put("/api/machinery/{id}")
def update_machinery(id: int, m: MachinerySchema):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
    UPDATE machinery
    SET plate_code=?, type=?, driver_id=?, accumulated_hours_km=?, maintenance_status=?
    WHERE id=?
    """, (m.plate_code, m.type, m.driver_id, m.accumulated_hours_km, m.maintenance_status, id))
    conn.commit()
    conn.close()
    return {"message": "Machinery updated successfully"}

@app.delete("/api/machinery/{id}")
def delete_machinery(id: int):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM machinery WHERE id=?", (id,))
    conn.commit()
    conn.close()
    return {"message": "Machinery deleted successfully"}


# 5. Products CRUD
@app.get("/api/products")
def get_products():
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM products ORDER BY name ASC")
    rows = cursor.fetchall()
    conn.close()
    return [to_dict(r) for r in rows]

@app.post("/api/products")
def create_product(p: ProductSchema):
    conn = get_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("""
        INSERT INTO products (name, cost, margin, profit, price)
        VALUES (?, ?, ?, ?, ?)
        """, (p.name, p.cost, p.margin, p.profit, p.price))
        conn.commit()
        return {"id": cursor.lastrowid, "message": "Product created successfully"}
    except DBIntegrityError:
        raise HTTPException(status_code=400, detail="Product name already exists.")
    finally:
        conn.close()

@app.put("/api/products/{id}")
def update_product(id: int, p: ProductSchema):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
    UPDATE products
    SET name=?, cost=?, margin=?, profit=?, price=?
    WHERE id=?
    """, (p.name, p.cost, p.margin, p.profit, p.price, id))
    conn.commit()
    conn.close()
    return {"message": "Product updated successfully"}

@app.delete("/api/products/{id}")
def delete_product(id: int):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM products WHERE id=?", (id,))
    conn.commit()
    conn.close()
    return {"message": "Product deleted successfully"}


# 6. Guides CRUD
@app.get("/api/guides")
def get_guides():
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT g.*, c.name as client_name, d.name as driver_name, p.name as product_name, p.price as product_price
        FROM work_guides g
        LEFT JOIN contacts c ON g.contact_id = c.id
        LEFT JOIN drivers d ON g.driver_id = d.id
        LEFT JOIN products p ON g.product_id = p.id
        ORDER BY g.guide_date DESC, g.id DESC
    """)
    rows = cursor.fetchall()
    conn.close()
    return [to_dict(r) for r in rows]

@app.post("/api/guides")
def save_guide(g: GuideSaveSchema):
    conn = get_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("""
        INSERT INTO work_guides (
            guide_number, guide_date, description, quantity, unit, project, 
            contact_id, plate_code, product_id, driver_id, signature_detected, 
            hours_worked, billing_status, purchase_order, recompra, resident
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pendiente', ?, ?, ?)
        """, (g.guide_number, g.guide_date, g.description, g.quantity, g.unit, g.project,
              g.contact_id, g.plate_code, g.product_id, g.driver_id, g.signature_detected,
              g.hours_worked, g.purchase_order, g.recompra, g.resident))
        
        # Automatically update Machinery Horometer/Odómetro if machinery plate is assigned and unit is HORA
        if g.plate_code and g.hours_worked > 0:
            cursor.execute("""
                UPDATE machinery 
                SET accumulated_hours_km = accumulated_hours_km + ? 
                WHERE plate_code = ?
            """, (g.hours_worked, g.plate_code))
            
        conn.commit()
        return {"id": cursor.lastrowid, "message": "Work guide saved successfully"}
    except DBIntegrityError:
        raise HTTPException(status_code=400, detail="Guide number already exists.")
    finally:
        conn.close()

@app.put("/api/guides/{id}")
def update_guide(id: int, g: GuideSaveSchema):
    conn = get_connection()
    cursor = conn.cursor()
    try:
        # Get old values first to adjust horometer if changed
        cursor.execute("SELECT plate_code, hours_worked FROM work_guides WHERE id=?", (id,))
        old = cursor.fetchone()
        
        cursor.execute("""
        UPDATE work_guides
        SET guide_number=?, guide_date=?, description=?, quantity=?, unit=?, project=?,
            contact_id=?, plate_code=?, product_id=?, driver_id=?, signature_detected=?, hours_worked=?,
            purchase_order=?, recompra=?, resident=?
        WHERE id=?
        """, (g.guide_number, g.guide_date, g.description, g.quantity, g.unit, g.project,
              g.contact_id, g.plate_code, g.product_id, g.driver_id, g.signature_detected, g.hours_worked,
              g.purchase_order, g.recompra, g.resident, id))
        
        # Adjust accumulated hours of machinery if modified
        if old:
            # Revert old hours
            if old["plate_code"] and old["hours_worked"] > 0:
                cursor.execute("UPDATE machinery SET accumulated_hours_km = accumulated_hours_km - ? WHERE plate_code = ?", (old["hours_worked"], old["plate_code"]))
            # Add new hours
            if g.plate_code and g.hours_worked > 0:
                cursor.execute("UPDATE machinery SET accumulated_hours_km = accumulated_hours_km + ? WHERE plate_code = ?", (g.hours_worked, g.plate_code))

        conn.commit()
        conn.close()
        return {"message": "Work guide updated successfully"}
    except DBIntegrityError:
        raise HTTPException(status_code=400, detail="Guide number already exists.")

@app.delete("/api/guides/{id}")
def delete_guide(id: int):
    conn = get_connection()
    cursor = conn.cursor()
    try:
        # Revert machinery hours before deleting
        cursor.execute("SELECT plate_code, hours_worked FROM work_guides WHERE id=?", (id,))
        old = cursor.fetchone()
        if old and old["plate_code"] and old["hours_worked"] > 0:
            cursor.execute("UPDATE machinery SET accumulated_hours_km = accumulated_hours_km - ? WHERE plate_code = ?", (old["hours_worked"], old["plate_code"]))
            
        cursor.execute("DELETE FROM work_guides WHERE id=?", (id,))
        conn.commit()
        return {"message": "Work guide deleted successfully"}
    finally:
        conn.close()


# 7. OCR Upload Endpoint
@app.post("/api/upload")
async def upload_guide_file(file: UploadFile = File(...)):
    # Save uploaded file
    file_ext = os.path.splitext(file.filename)[1]
    saved_filename = f"upload_{int(datetime.now().timestamp())}{file_ext}"
    saved_path = os.path.join(UPLOAD_DIR, saved_filename)
    
    with open(saved_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)
        
    # Analyze image using our OCR module
    try:
        extracted = analyze_guide_image(saved_path, original_filename=file.filename)
    except Exception as e:
        logger.error(f"Error in OCR module: {e}")
        # Return empty structured data on failure
        extracted = {
            "guide_number": "", "guide_date": "", "client_name": "", 
            "driver_name": "", "plate_code": "", "project": "", 
            "description": "", "quantity": 1.0, "unit": "VIAJE", 
            "signature_detected": 0, "hours_worked": 0.0,
            "purchase_order": "", "recompra": "", "resident": ""
        }
        
    extracted["image_url"] = f"/uploads/{saved_filename}"

    # --- Match extracted entities to Database IDs ---
    conn = get_connection()
    cursor = conn.cursor()
    try:
        # Match Client
        contact_id = None
        if extracted["client_name"]:
            client_lower = extracted["client_name"].lower()
            if any(k in client_lower for k in ["rip", "conciu", "pip"]):
                contact_id = 1  # RIPCONCIV CONSTRUCTORA
            elif any(k in client_lower for k in ["modena", "moden", "urban", "project s.a."]):
                contact_id = 2  # PROMOTORA Y PROYECTOS URBAN – PROJECT S.A. (MODENA)
            elif any(k in client_lower for k in ["hydr", "hidr", "pac", "hiadra", "hydra"]):
                contact_id = 3  # HYDRIAPAC S.A.
            else:
                cursor.execute("SELECT id FROM contacts WHERE name LIKE ? OR ruc = ?", (f"%{extracted['client_name']}%", extracted["client_name"]))
                match = cursor.fetchone()
                if match:
                    contact_id = match["id"]
        extracted["contact_id"] = contact_id

        # Match Driver
        driver_id = None
        if extracted["driver_name"]:
            cursor.execute("SELECT id FROM drivers WHERE name LIKE ? OR dni = ?", (f"%{extracted['driver_name']}%", extracted["driver_name"]))
            match = cursor.fetchone()
            if match:
                driver_id = match["id"]

        # Match Plate
        plate_code = None
        if extracted["plate_code"]:
            cursor.execute("SELECT plate_code, driver_id FROM machinery WHERE plate_code = ? OR plate_code LIKE ?", (extracted["plate_code"], f"%{extracted['plate_code']}%"))
            match = cursor.fetchone()
            if match:
                plate_code = match["plate_code"]
                # Fallback: if driver not matched by name, use the machinery's assigned driver
                if not driver_id and match["driver_id"]:
                    driver_id = match["driver_id"]
        extracted["plate_code"] = plate_code
        extracted["driver_id"] = driver_id

        # Match Product
        product_id = None
        if extracted["description"]:
            # Try to match product names
            cursor.execute("SELECT id FROM products ORDER BY LENGTH(name) DESC")
            all_products = cursor.fetchall()
            for prod in all_products:
                if prod["id"] == 1 or prod["id"] == 2:  # Skip generic transport/rental matches unless direct match
                    continue
                # Search product name in description
                # e.g., if description contains 'SUB BASE', match that
                cursor.execute("SELECT name FROM products WHERE id=?", (prod["id"],))
                pname = cursor.fetchone()["name"].lower()
                if pname in extracted["description"].lower() or pname in extracted["project"].lower():
                    product_id = prod["id"]
                    break
            
            # Fallback to desalojo or general categories if containing certain keywords
            if not product_id:
                desc_lower = extracted["description"].lower()
                if "desalojo" in desc_lower:
                    product_id = 10  # DESALOJO
                elif "retro" in desc_lower:
                    product_id = 6   # ALQUILER RETROEXCAVADORA
                elif "excavadora" in desc_lower:
                    product_id = 7   # ALQUILER EXCAVADORA
                elif "cama baja" in desc_lower:
                    product_id = 1   # TRANSPORTE CAMA BAJA
                elif "volqueta" in desc_lower:
                    product_id = 2   # ALQUILER VOLQUETA MULA
                elif "base" in desc_lower or "sub base" in desc_lower:
                    product_id = 5   # SUB BASE
                elif "piedra" in desc_lower:
                    product_id = 3   # PIEDRA 3/4
                elif "cascajo" in desc_lower or "cascado" in desc_lower:
                    product_id = 8   # CASCAJO
                elif "ripio" in desc_lower or "ripid" in desc_lower:
                    product_id = 3   # PIEDRA 3/4
        extracted["product_id"] = product_id

        return extracted
    finally:
        conn.close()


# 8. Mass Billing (Generación de Facturas)
@app.post("/api/invoices/generate-mass")
def generate_mass_invoices(payload: InvoiceGenerateSchema):
    if not payload.guide_ids:
        raise HTTPException(status_code=400, detail="No guides selected.")
        
    conn = get_connection()
    cursor = conn.cursor()
    try:
        # Load all selected guides
        placeholders = ",".join("?" for _ in payload.guide_ids)
        cursor.execute(f"""
            SELECT g.*, p.price, p.name as product_name
            FROM work_guides g
            LEFT JOIN products p ON g.product_id = p.id
            WHERE g.id IN ({placeholders}) AND g.billing_status = 'Pendiente'
        """, payload.guide_ids)
        guides = cursor.fetchall()

        if not guides:
            raise HTTPException(status_code=400, detail="None of the selected guides are eligible for billing (must be 'Pendiente').")

        # Group guides by contact_id
        grouped_guides = {}
        for g in guides:
            cid = g["contact_id"]
            if not cid:
                raise HTTPException(status_code=400, detail=f"Guide #{g['guide_number']} has no client assigned. Please edit the guide first.")
            if cid not in grouped_guides:
                grouped_guides[cid] = []
            grouped_guides[cid].append(g)

        generated_invoices = []

        for cid, client_guides in grouped_guides.items():
            # Compute subtotal
            subtotal = 0.0
            for g in client_guides:
                price = g["price"] or 0.0
                subtotal += g["quantity"] * price

            # Compute VAT (IVA)
            iva_rate = payload.iva_percentage / 100.0
            iva = subtotal * iva_rate
            total = subtotal + iva

            # Insert Invoice (Draft / Pendiente status)
            invoice_date = datetime.now().strftime("%Y-%m-%d")
            cursor.execute("""
                INSERT INTO invoices (
                    client_id, invoice_date, subtotal, iva_percentage, iva, 
                    withholding_rent, withholding_iva, total, approval_status, 
                    sri_status, payment_status, amount_paid, amount_pending
                ) VALUES (?, ?, ?, ?, ?, 0.0, 0.0, ?, 'Pendiente', 'Pendiente de Emisión', 'No Pagada', 0.0, ?)
            """, (cid, invoice_date, subtotal, payload.iva_percentage, iva, total, total))
            
            invoice_id = cursor.lastrowid
            
            # Link work guides to this invoice and update their billing status
            guide_ids = [g["id"] for g in client_guides]
            guide_placeholders = ",".join("?" for _ in guide_ids)
            cursor.execute(f"""
                UPDATE work_guides
                SET billing_status = 'En Proceso', invoice_id = ?
                WHERE id IN ({guide_placeholders})
            """, [invoice_id] + guide_ids)

            generated_invoices.append({
                "invoice_id": invoice_id,
                "client_id": cid,
                "subtotal": subtotal,
                "iva": iva,
                "total": total,
                "guides_count": len(client_guides)
            })

        conn.commit()
        return {"message": "Draft invoices generated successfully", "invoices": generated_invoices}
    except Exception as e:
        conn.rollback()
        raise HTTPException(status_code=500, detail=f"Error generating invoices: {e}")
    finally:
        conn.close()


# 9. Invoices endpoints
@app.get("/api/invoices")
def get_invoices():
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT i.*, c.name as client_name, c.ruc as client_ruc, c.email as client_email
        FROM invoices i
        JOIN contacts c ON i.client_id = c.id
        ORDER BY i.invoice_date DESC, i.id DESC
    """)
    rows = cursor.fetchall()
    conn.close()
    return [to_dict(r) for r in rows]

@app.get("/api/invoices/{id}")
def get_invoice_detail(id: int):
    conn = get_connection()
    cursor = conn.cursor()
    try:
        # Load Invoice
        cursor.execute("""
            SELECT i.*, c.name as client_name, c.ruc as client_ruc, c.address as client_address, 
                   c.phone as client_phone, c.email as client_email
            FROM invoices i
            JOIN contacts c ON i.client_id = c.id
            WHERE i.id = ?
        """, (id,))
        inv = cursor.fetchone()
        if not inv:
            raise HTTPException(status_code=404, detail="Invoice not found.")

        # Load Linked Guides
        cursor.execute("""
            SELECT g.*, p.name as product_name, p.price as product_price
            FROM work_guides g
            LEFT JOIN products p ON g.product_id = p.id
            WHERE g.invoice_id = ?
            ORDER BY g.guide_date ASC
        """, (id,))
        guides = cursor.fetchall()

        return {
            "invoice": to_dict(inv),
            "guides": [to_dict(g) for g in guides]
        }
    finally:
        conn.close()

# Update Invoice (before approval)
@app.put("/api/invoices/{id}")
def update_invoice(id: int, payload: InvoiceUpdateSchema):
    conn = get_connection()
    cursor = conn.cursor()
    try:
        # Check if invoice exists and is still "Pendiente" (revisable)
        cursor.execute("SELECT approval_status FROM invoices WHERE id=?", (id,))
        inv = cursor.fetchone()
        if not inv:
            raise HTTPException(status_code=404, detail="Invoice not found.")
        if inv["approval_status"] != "Pendiente":
            raise HTTPException(status_code=400, detail="Only pending invoices can be edited.")
            
        cursor.execute("""
            UPDATE invoices
            SET client_id = ?, invoice_date = ?, subtotal = ?, iva_percentage = ?, iva = ?, total = ?, amount_pending = ?
            WHERE id = ?
        """, (payload.client_id, payload.invoice_date, payload.subtotal, payload.iva_percentage, payload.iva, payload.total, payload.total, id))
        
        # Also update linked guides to have the new client contact_id
        cursor.execute("""
            UPDATE work_guides
            SET contact_id = ?
            WHERE invoice_id = ?
        """, (payload.client_id, id))
        
        conn.commit()
        return {"message": "Invoice updated successfully"}
    finally:
        conn.close()

# Delete Invoice (before approval)
@app.delete("/api/invoices/{id}")
def delete_invoice(id: int):
    conn = get_connection()
    cursor = conn.cursor()
    try:
        # Check if invoice exists and is still "Pendiente"
        cursor.execute("SELECT approval_status FROM invoices WHERE id=?", (id,))
        inv = cursor.fetchone()
        if not inv:
            raise HTTPException(status_code=404, detail="Invoice not found.")
        if inv["approval_status"] != "Pendiente":
            raise HTTPException(status_code=400, detail="Only pending invoices can be deleted.")
            
        # Revert linked guides to 'Pendiente' and unlink
        cursor.execute("UPDATE work_guides SET billing_status = 'Pendiente', invoice_id = NULL WHERE invoice_id = ?", (id,))
        
        # Delete invoice
        cursor.execute("DELETE FROM invoices WHERE id = ?", (id,))
        
        conn.commit()
        return {"message": "Invoice deleted successfully and guides reverted to pending."}
    finally:
        conn.close()

# Update approval status (Supervisor role)
@app.put("/api/invoices/{id}/status")
def update_invoice_status(id: int, payload: dict):
    approval_status = payload.get("approval_status")
    rejection_reason = payload.get("rejection_reason", "")
    
    if approval_status not in ["Aprobada", "Rechazada"]:
        raise HTTPException(status_code=400, detail="Invalid approval status.")
        
    conn = get_connection()
    cursor = conn.cursor()
    try:
        # Check current status
        cursor.execute("SELECT approval_status, client_id, total FROM invoices WHERE id=?", (id,))
        inv = cursor.fetchone()
        if not inv:
            raise HTTPException(status_code=404, detail="Invoice not found.")

        old_status = inv["approval_status"]
        
        cursor.execute("""
            UPDATE invoices
            SET approval_status = ?, rejection_reason = ?
            WHERE id = ?
        """, (approval_status, rejection_reason, id))
        
        # If approved, guides billing_status becomes 'Facturado'. If rejected, reverts to 'Pendiente'
        if approval_status == "Aprobada":
            cursor.execute("UPDATE work_guides SET billing_status = 'Facturado' WHERE invoice_id = ?", (id,))
            # Add invoice total to client balance
            cursor.execute("UPDATE contacts SET current_balance = current_balance + ? WHERE id = ?", (inv["total"], inv["client_id"]))
        elif approval_status == "Rechazada":
            cursor.execute("UPDATE work_guides SET billing_status = 'Pendiente', invoice_id = NULL WHERE invoice_id = ?", (id,))
            
        conn.commit()
        return {"message": f"Invoice status updated to {approval_status}"}
    except Exception as e:
        conn.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        conn.close()

# Emit SRI Electronic Invoicing (Facturador role)
@app.post("/api/invoices/{id}/emit-sri")
def emit_sri_invoice(id: int):
    conn = get_connection()
    cursor = conn.cursor()
    try:
        # Load invoice detail
        cursor.execute("""
            SELECT i.*, c.name as client_name, c.ruc as client_ruc, c.email as client_email
            FROM invoices i
            JOIN contacts c ON i.client_id = c.id
            WHERE i.id = ?
        """, (id,))
        inv = cursor.fetchone()
        
        if not inv:
            raise HTTPException(status_code=404, detail="Invoice not found.")
        if inv["approval_status"] != "Aprobada":
            raise HTTPException(status_code=400, detail="Only approved invoices can be emitted to SRI.")
        if inv["sri_status"] == "Autorizada":
            return {"message": "Invoice already authorized by SRI", "access_key": inv["sri_access_key"]}

        # Generate Ecuador 49-digit access key
        # Format: DDMMAAAA01 + RUC + TIPO_AMBIENTE(1 o 2) + SERIE(001001) + SECUENCIAL(9 digitos) + CODIGO_NUMERICO(8 digitos) + TIPO_EMISION(1) + DIGITO_VERIFICADOR
        now_str = datetime.now().strftime("%d%m%Y")
        ruc = inv["client_ruc"].ljust(13, "0")[:13]
        sec = str(id).zfill(9)
        rand_code = "".join(str(random.randint(0, 9)) for _ in range(8))
        key_without_dv = f"{now_str}01{ruc}1001001{sec}{rand_code}1"
        
        # Calculate Modulo 11 verification digit
        factor = 2
        total_sum = 0
        for digit in reversed(key_without_dv):
            total_sum += int(digit) * factor
            factor = factor + 1 if factor < 7 else 2
        digit_ver = 11 - (total_sum % 11)
        if digit_ver == 11:
            digit_ver = 0
        elif digit_ver == 10:
            digit_ver = 1
            
        access_key = f"{key_without_dv}{digit_ver}"

        # Update SRI status in database
        cursor.execute("""
            UPDATE invoices
            SET sri_status = 'Autorizada', sri_access_key = ?
            WHERE id = ?
        """, (access_key, id))

        # Build mock XML
        cursor.execute("""
            SELECT g.*, p.price, p.name as product_name
            FROM work_guides g
            JOIN products p ON g.product_id = p.id
            WHERE g.invoice_id = ?
        """, (id,))
        guides = cursor.fetchall()

        xml_details = ""
        for g in guides:
            xml_details += f"""
            <detalle>
                <codigoPrincipal>{g['product_id']}</codigoPrincipal>
                <descripcion>{g['product_name']} - Obra: {g['project']}</descripcion>
                <cantidad>{g['quantity']}</cantidad>
                <precioUnitario>{g['price']}</precioUnitario>
                <descuento>0.00</descuento>
                <precioTotalSinImpuesto>{g['quantity'] * g['price']}</precioTotalSinImpuesto>
            </detalle>"""

        mock_xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<factura id="comprobante" version="1.1.0">
    <infoTributaria>
        <ambiente>1</ambiente>
        <tipoEmision>1</tipoEmision>
        <razonSocial>TRANSJULCAMP S.A.</razonSocial>
        <nombreComercial>TRANSJULCAMP</nombreComercial>
        <ruc>0993171085001</ruc>
        <claveAcceso>{access_key}</claveAcceso>
        <codDoc>01</codDoc>
        <estab>001</estab>
        <ptoEmi>001</ptoEmi>
        <secuencial>{sec}</secuencial>
        <dirMatriz>COLINAS DE LA ALBORADA MZ 726 V.6</dirMatriz>
    </infoTributaria>
    <infoFactura>
        <fechaEmision>{datetime.strptime(inv['invoice_date'], '%Y-%m-%d').strftime('%d/%m/%Y')}</fechaEmision>
        <obligadoContabilidad>SI</obligadoContabilidad>
        <tipoIdentificacionComprador>04</tipoIdentificacionComprador>
        <razonSocialComprador>{inv['client_name']}</razonSocialComprador>
        <identificacionComprador>{inv['client_ruc']}</identificacionComprador>
        <totalSinImpuestos>{inv['subtotal']}</totalSinImpuestos>
        <totalDescuento>0.00</totalDescuento>
        <totalConImpuestos>
            <totalImpuesto>
                <codigo>2</codigo>
                <codigoPorcentaje>2</codigoPorcentaje>
                <baseImponible>{inv['subtotal']}</baseImponible>
                <valor>{inv['iva']}</valor>
            </totalImpuesto>
        </totalConImpuestos>
        <importeTotal>{inv['total']}</importeTotal>
        <moneda>DOLAR</moneda>
    </infoFactura>
    <detalles>
        {xml_details}
    </detalles>
    <signature>
        <ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Id="Signature-TRANSJULCAMP">
            <ds:SignedInfo>
                <ds:SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"/>
            </ds:SignedInfo>
            <ds:SignatureValue>MOCK_SIGNATURE_VALUE_TRANSJULCAMP_ELECTRONIC_BILLING</ds:SignatureValue>
        </ds:Signature>
    </signature>
</factura>"""

        conn.commit()
        return {
            "message": "Invoice successfully authorized by SRI Ecuador",
            "access_key": access_key,
            "xml": mock_xml
        }
    except Exception as e:
        conn.rollback()
        raise HTTPException(status_code=500, detail=f"SRI Error: {e}")
    finally:
        conn.close()

# Record payment and withholdings (Cobros)
@app.post("/api/invoices/{id}/pay")
def pay_invoice(id: int, payload: PaymentSchema):
    conn = get_connection()
    cursor = conn.cursor()
    try:
        # Load invoice
        cursor.execute("SELECT * FROM invoices WHERE id = ?", (id,))
        inv = cursor.fetchone()
        
        if not inv:
            raise HTTPException(status_code=404, detail="Invoice not found.")
        if inv["approval_status"] != "Aprobada":
            raise HTTPException(status_code=400, detail="Cannot register payments on unapproved invoices.")

        total_to_pay = inv["total"]
        # Add current payment, rent withholding, and IVA withholding to the amount already paid
        new_withholding_rent = inv["withholding_rent"] + payload.withholding_rent
        new_withholding_iva = inv["withholding_iva"] + payload.withholding_iva
        
        # Deduct this payment session's actual cash + retenciones from client balance
        # Wait, the total credit decrease includes the cash paid AND the withholdings (since they count as payment credits)
        total_payment_credit = payload.amount_paid + payload.withholding_rent + payload.withholding_iva
        new_amount_paid = inv["amount_paid"] + total_payment_credit
        
        if new_amount_paid > total_to_pay + 0.01: # allow minor rounding
            raise HTTPException(status_code=400, detail=f"Amount exceeds total invoice amount. Total invoice: {total_to_pay}, Total paid + withholdings: {new_amount_paid}")

        new_amount_pending = total_to_pay - new_amount_paid
        
        # Update payment status
        if new_amount_pending <= 0.05:
            payment_status = "Pagada"
            new_amount_pending = 0.0
        elif new_amount_paid > 0:
            payment_status = "Pago Parcial"
        else:
            payment_status = "No Pagada"

        cursor.execute("""
            UPDATE invoices
            SET amount_paid = ?, amount_pending = ?, payment_status = ?,
                withholding_rent = ?, withholding_iva = ?
            WHERE id = ?
        """, (new_amount_paid, new_amount_pending, payment_status, new_withholding_rent, new_withholding_iva, id))

        # Update client balance
        cursor.execute("""
            UPDATE contacts
            SET current_balance = current_balance - ?
            WHERE id = ?
        """, (total_payment_credit, inv["client_id"]))

        conn.commit()
        return {
            "message": "Payment recorded successfully",
            "payment_status": payment_status,
            "amount_paid": new_amount_paid,
            "amount_pending": new_amount_pending
        }
    except Exception as e:
        conn.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        conn.close()

# --- SCHEDULES CRUD ENDPOINTS ---

@app.get("/api/schedules")
def get_schedules():
    conn = get_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("""
            SELECT s.*, d.name as driver_name, c.name as client_name
            FROM schedules s
            LEFT JOIN drivers d ON s.driver_id = d.id
            LEFT JOIN contacts c ON s.contact_id = c.id
            ORDER BY s.start_date DESC, s.id DESC
        """)
        rows = cursor.fetchall()
        return [to_dict(r) for r in rows]
    finally:
        conn.close()

@app.post("/api/schedules")
def create_schedule(s: ScheduleSchema):
    conn = get_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("""
            INSERT INTO schedules (driver_id, plate_code, start_date, end_date, planned_hours, project, contact_id, description)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (s.driver_id, s.plate_code, s.start_date, s.end_date, s.planned_hours, s.project, s.contact_id, s.description))
        conn.commit()
        return {"id": cursor.lastrowid, "message": "Schedule created successfully"}
    finally:
        conn.close()

@app.put("/api/schedules/{id}")
def update_schedule(id: int, s: ScheduleSchema):
    conn = get_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("""
            UPDATE schedules
            SET driver_id = ?, plate_code = ?, start_date = ?, end_date = ?, planned_hours = ?, project = ?, contact_id = ?, description = ?
            WHERE id = ?
        """, (s.driver_id, s.plate_code, s.start_date, s.end_date, s.planned_hours, s.project, s.contact_id, s.description, id))
        conn.commit()
        return {"message": "Schedule updated successfully"}
    finally:
        conn.close()

@app.delete("/api/schedules/{id}")
def delete_schedule(id: int):
    conn = get_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("DELETE FROM schedules WHERE id = ?", (id,))
        conn.commit()
        return {"message": "Schedule deleted successfully"}
    finally:
        conn.close()

# Mount Static Files (at the end so API endpoints take priority)
static_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "static")
if not os.path.exists(static_dir):
    os.makedirs(static_dir)

# Mount uploaded guide files so they can be rendered in the UI
app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")
app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")

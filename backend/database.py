import os
import sqlite3
import psycopg2

# Try loading from local .env if it exists
if os.path.exists(".env"):
    with open(".env", "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ[k.strip()] = v.strip()

class CompatibleRow(dict):
    def __init__(self, dict_data, tuple_data):
        super().__init__(dict_data)
        self.tuple_data = tuple_data

    def __getitem__(self, key):
        if isinstance(key, int):
            return self.tuple_data[key]
        return super().__getitem__(key)

    def get(self, key, default=None):
        if isinstance(key, int):
            try:
                return self.tuple_data[key]
            except IndexError:
                return default
        return super().get(key, default)

class PostgresCursorWrapper:
    def __init__(self, cursor):
        self.cursor = cursor
        self._lastrowid = None

    def _translate(self, query):
        # Translate autoincrement
        if "INTEGER PRIMARY KEY AUTOINCREMENT" in query.upper():
            query = query.replace("INTEGER PRIMARY KEY AUTOINCREMENT", "SERIAL PRIMARY KEY")
        if "integer primary key autoincrement" in query.upper():
            query = query.replace("integer primary key autoincrement", "SERIAL PRIMARY KEY")
            
        # Translate INSERT OR IGNORE
        if "INSERT OR IGNORE INTO" in query.upper():
            query = query.replace("INSERT OR IGNORE INTO", "INSERT INTO")
            q_upper = query.upper()
            if "USERS" in q_upper:
                query = query.rstrip().rstrip(";") + " ON CONFLICT (username) DO NOTHING;"
            elif "CONTACTS" in q_upper:
                query = query.rstrip().rstrip(";") + " ON CONFLICT (id) DO NOTHING;"
            elif "DRIVERS" in q_upper:
                query = query.rstrip().rstrip(";") + " ON CONFLICT (id) DO NOTHING;"
            elif "PRODUCTS" in q_upper:
                query = query.rstrip().rstrip(";") + " ON CONFLICT (id) DO NOTHING;"
            elif "MACHINERY" in q_upper:
                query = query.rstrip().rstrip(";") + " ON CONFLICT (plate_code) DO NOTHING;"
            elif "INVOICES" in q_upper:
                query = query.rstrip().rstrip(";") + " ON CONFLICT (id) DO NOTHING;"
            elif "WORK_GUIDES" in q_upper:
                query = query.rstrip().rstrip(";") + " ON CONFLICT (guide_number) DO NOTHING;"
            elif "SCHEDULES" in q_upper:
                query = query.rstrip().rstrip(";") + " ON CONFLICT (id) DO NOTHING;"
                
        # Translate ADD COLUMN to ADD COLUMN IF NOT EXISTS
        if "ADD COLUMN" in query.upper() and "IF NOT EXISTS" not in query.upper():
            query = query.replace("ADD COLUMN", "ADD COLUMN IF NOT EXISTS")
            query = query.replace("add column", "ADD COLUMN IF NOT EXISTS")
                
        # Translate placeholder ? to %s
        query = query.replace("?", "%s")
        return query

    def execute(self, query, params=None):
        # Translate PRAGMA
        if "PRAGMA" in query.upper():
            return
            
        query = self._translate(query)
        
        # Handle lastrowid for INSERT
        is_insert = query.strip().upper().startswith("INSERT")
        if is_insert and "RETURNING" not in query.upper():
            q_strip = query.rstrip().rstrip(";")
            query = q_strip + " RETURNING id;"
            
        try:
            if params is not None:
                self.cursor.execute(query, params)
            else:
                self.cursor.execute(query)
        except Exception as e:
            print(f"DATABASE QUERY FAILED: {query}")
            print(f"EXCEPTION: {e}")
            raise e
            
        if is_insert:
            try:
                row = self.cursor.fetchone()
                if row:
                    self._lastrowid = row[0]
            except Exception:
                pass

    def executemany(self, query, params_list):
        if "PRAGMA" in query.upper():
            return
            
        query = self._translate(query)
        self.cursor.executemany(query, params_list)

    @property
    def lastrowid(self):
        return self._lastrowid

    def _row_to_dict(self, row):
        if row is None:
            return None
        colnames = [desc[0] for desc in self.cursor.description]
        dict_data = dict(zip(colnames, row))
        return CompatibleRow(dict_data, tuple(row))

    def fetchone(self):
        row = self.cursor.fetchone()
        return self._row_to_dict(row)

    def fetchall(self):
        rows = self.cursor.fetchall()
        return [self._row_to_dict(r) for r in rows]

    def close(self):
        self.cursor.close()

    def __getattr__(self, name):
        return getattr(self.cursor, name)

class PostgresConnectionWrapper:
    def __init__(self, conn):
        self.conn = conn

    def cursor(self):
        cursor = self.conn.cursor()
        return PostgresCursorWrapper(cursor)

    def commit(self):
        self.conn.commit()

    def rollback(self):
        self.conn.rollback()

    def close(self):
        self.conn.close()

    def __getattr__(self, name):
        return getattr(self.conn, name)

DATABASE_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "db", "transjulcamp.db")

def get_connection():
    supabase_url = os.getenv("SUPABASE_DB_URL")
    if supabase_url:
        conn = psycopg2.connect(supabase_url)
        return PostgresConnectionWrapper(conn)
    else:
        db_dir = os.path.dirname(DATABASE_PATH)
        if not os.path.exists(db_dir):
            os.makedirs(db_dir)
        conn = sqlite3.connect(DATABASE_PATH)
        conn.row_factory = sqlite3.Row
        return conn

def init_db():
    conn = get_connection()
    cursor = conn.cursor()

    # Enable foreign keys
    cursor.execute("PRAGMA foreign_keys = ON;")

    # 1. Contacts
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS contacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        ruc TEXT NOT NULL UNIQUE,
        address TEXT,
        phone TEXT,
        email TEXT,
        credit_limit REAL DEFAULT 0,
        current_balance REAL DEFAULT 0
    );
    """)

    # 2. Drivers
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS drivers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        dni TEXT NOT NULL UNIQUE,
        phone TEXT,
        address TEXT,
        status TEXT NOT NULL CHECK(status IN ('Activo', 'Inactivo')) DEFAULT 'Activo'
    );
    """)

    # 3. Machinery
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS machinery (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plate_code TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        driver_id INTEGER,
        accumulated_hours_km REAL DEFAULT 0,
        maintenance_status TEXT NOT NULL CHECK(maintenance_status IN ('Operativo', 'Mantenimiento', 'Reparación')) DEFAULT 'Operativo',
        last_maintenance_date TEXT,
        FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE SET NULL
    );
    """)

    # 4. Products
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        cost REAL DEFAULT 0,
        margin REAL DEFAULT 0,
        profit REAL DEFAULT 0,
        price REAL DEFAULT 0
    );
    """)

    # 5. Invoices
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS invoices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id INTEGER NOT NULL,
        invoice_date TEXT NOT NULL,
        subtotal REAL DEFAULT 0,
        iva_percentage REAL DEFAULT 15.0,
        iva REAL DEFAULT 0,
        withholding_rent REAL DEFAULT 0,
        withholding_iva REAL DEFAULT 0,
        total REAL DEFAULT 0,
        approval_status TEXT NOT NULL CHECK(approval_status IN ('Pendiente', 'Aprobada', 'Rechazada')) DEFAULT 'Pendiente',
        rejection_reason TEXT,
        sri_status TEXT NOT NULL CHECK(sri_status IN ('Pendiente de Emisión', 'Emitida', 'Autorizada')) DEFAULT 'Pendiente de Emisión',
        payment_status TEXT NOT NULL CHECK(payment_status IN ('No Pagada', 'Pago Parcial', 'Pagada')) DEFAULT 'No Pagada',
        amount_paid REAL DEFAULT 0,
        amount_pending REAL DEFAULT 0,
        sri_access_key TEXT,
        FOREIGN KEY (client_id) REFERENCES contacts(id)
    );
    """)

    # 6. Work Guides
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS work_guides (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        image_url TEXT,
        guide_date TEXT NOT NULL,
        guide_number TEXT NOT NULL UNIQUE,
        description TEXT,
        quantity REAL NOT NULL,
        unit TEXT NOT NULL CHECK(unit IN ('M3', 'HORA', 'VIAJE', 'DIA')),
        project TEXT,
        contact_id INTEGER,
        plate_code TEXT,
        product_id INTEGER,
        driver_id INTEGER,
        signature_detected INTEGER CHECK(signature_detected IN (0, 1)) DEFAULT 0,
        hours_worked REAL DEFAULT 0,
        billing_status TEXT NOT NULL CHECK(billing_status IN ('Pendiente', 'En Proceso', 'Facturado')) DEFAULT 'Pendiente',
        invoice_id INTEGER,
        purchase_order TEXT,
        recompra TEXT,
        resident TEXT,
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL,
        FOREIGN KEY (plate_code) REFERENCES machinery(plate_code) ON DELETE SET NULL,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL,
        FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE SET NULL,
        FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE SET NULL
    );
    """)

    # 7. Users
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('Admin', 'Supervisor', 'Facturador'))
    );
    """)

    # 8. Schedules (Planning)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        driver_id INTEGER,
        plate_code TEXT,
        start_date TEXT NOT NULL,
        end_date TEXT NOT NULL,
        planned_hours REAL DEFAULT 0,
        project TEXT,
        contact_id INTEGER,
        description TEXT,
        FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE SET NULL,
        FOREIGN KEY (plate_code) REFERENCES machinery(plate_code) ON DELETE SET NULL,
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL
    );
    """)

    # Runtime migrations for existing tables
    for col in ["purchase_order", "recompra", "resident"]:
        try:
            cursor.execute(f"ALTER TABLE work_guides ADD COLUMN {col} TEXT;")
        except Exception:
            pass  # Column already exists

    conn.commit()
    seed_data(conn)
    conn.close()
    print("Database initialized successfully.")


def seed_data(conn):
    cursor = conn.cursor()

    # Seed Contacts (Clientes) with explicit IDs
    contacts = [
        (1, "RIPCONCIV CONSTRUCTORA", "1791234567001", "Av. Amazonas y Eloy Alfaro, Quito", "02-2900-100", "facturacion@ripconciv.com", 50000.0, 12450.0),
        (2, "PROMOTORA Y PROYECTOS URBAN – PROJECT S.A. (MODENA)", "0993123456001", "Km 2.5 Av. Samborondón, Guayaquil", "04-2099-200", "pagos@modena.com.ec", 100000.0, 21500.0),
        (3, "HYDRIAPAC S.A.", "0998765432001", "Km 14.5 Vía a la Costa, Guayaquil", "04-2899-300", "contabilidad@hydriapac.com", 80000.0, 2784.0)
    ]
    cursor.executemany("""
    INSERT OR IGNORE INTO contacts (id, name, ruc, address, phone, email, credit_limit, current_balance)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    """, contacts)

    # Seed Drivers (Choferes) with explicit IDs
    drivers = [
        (1, "JORGE MOREIRA", "0921478563", "Cooperativa Juan Montalvo, Guayaquil", "0988728426", "Activo"),
        (2, "FERNANDO ALVARADO", "1105478962", "Calle Bolívar y 10 de Agosto, Loja", "0993334444", "Activo"),
        (3, "MARIO PINTO", "1712806916", "Comité del Pueblo, Quito", "0995556666", "Activo")
    ]
    cursor.executemany("""
    INSERT OR IGNORE INTO drivers (id, name, dni, phone, address, status)
    VALUES (?, ?, ?, ?, ?, ?)
    """, drivers)

    # Seed Products (Productos/Servicios) with explicit IDs
    products = [
        (1, "TRANSPORTE DE MAQUINARIA EN CAMA BAJA", 80.0, 36.0, 45.0, 125.0),
        (2, "ALQUILER DE VOLQUETA MULA", 200.0, 28.57, 80.0, 280.0),
        (3, "PIEDRA 3/4", 12.0, 35.135, 6.5, 18.5),
        (4, "PIEDRA 3/8", 15.0, 30.23, 6.5, 21.5),
        (5, "SUB BASE", 18.0, 32.71, 8.75, 26.75),
        (6, "ALQUILER RETROEXCAVADORA", 20.0, 33.333, 10.0, 30.0),
        (7, "ALQUILER EXCAVADORA HYUNDAI 215L", 35.0, 33.962, 18.0, 53.0),
        (8, "CASCAJO", 3.5, 34.579, 1.85, 5.35),
        (9, "ARENA GRUESA", 7.5, 33.804, 3.83, 11.33),
        (10, "DESALOJO", 30.0, 40.594, 20.5, 50.5)
    ]
    cursor.executemany("""
    INSERT OR IGNORE INTO products (id, name, cost, margin, profit, price)
    VALUES (?, ?, ?, ?, ?, ?)
    """, products)

    # Seed Machinery (Volquetas / Excavadoras)
    machinery = [
        ("ESI-3413", "Volqueta Mula", 1, 120.0, "Operativo", "2026-05-10"),
        ("PBL-3806", "Volqueta", 3, 95.0, "Operativo", "2026-06-01"),
        ("GSI-3442", "Volqueta Mula", 1, 210.0, "Operativo", "2026-05-20"),
        ("GRD-0900", "Volqueta Mula", 3, 180.0, "Operativo", "2026-06-15"),
        ("XBP-719", "Volqueta", 2, 150.0, "Operativo", "2026-06-20"),
        ("EXCAVADORA HYUNDAI 215L #1", "Excavadora", 2, 210.5, "Operativo", "2026-05-01"),
        ("RETROEXCAVADORA CASE #1", "Retroexcavadora", 2, 80.0, "Operativo", "2026-06-05")
    ]
    cursor.executemany("""
    INSERT OR IGNORE INTO machinery (plate_code, type, driver_id, accumulated_hours_km, maintenance_status, last_maintenance_date)
    VALUES (?, ?, ?, ?, ?, ?)
    """, machinery)

    # Seed Initial Invoices with explicit IDs
    invoices = [
        (1, 2, "2026-06-19", 21500.0, 15.0, 3225.0, 0.0, 0.0, 24725.0, "Aprobada", "Autorizada", "No Pagada", 0.0, 24725.0, "1906202601099312345600120010010000000011234567819"),
        (2, 1, "2026-06-23", 6000.0, 15.0, 900.0, 120.0, 270.0, 6510.0, "Aprobada", "Autorizada", "Pago Parcial", 3000.0, 3510.0, "2306202601179123456700120010010000000021234567814")
    ]
    cursor.executemany("""
    INSERT OR IGNORE INTO invoices (id, client_id, invoice_date, subtotal, iva_percentage, iva, withholding_rent, withholding_iva, total, approval_status, sri_status, payment_status, amount_paid, amount_pending, sri_access_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, invoices)

    # Seed Work Guides (existing guides, some linked to above invoices, some unbilled)
    guides_hydriapac = [
        ("38606", "2026-06-22", "SUB BASE Posorja", 14.0, "M3", "POSORJA", 3, "PBL-3806", 5, 3, 1, 0.0, "Pendiente", None),
        ("2487", "2026-06-23", "ALQUILER RETROEXCAVADORA Camp. Sur", 9.0, "HORA", "CAMP. SUR", 3, "RETROEXCAVADORA CASE #1", 6, 2, 1, 9.0, "Pendiente", None),
        ("38462", "2026-06-23", "PIEDRA 3/4 Camp. Sur", 14.0, "M3", "CAMP. SUR", 3, "GSI-3442", 3, 1, 1, 0.0, "Pendiente", None),
        ("35150", "2026-06-23", "SUB BASE Camp. Sur", 14.0, "M3", "CAMP. SUR", 3, "GRD-0900", 5, 3, 1, 0.0, "Pendiente", None),
        ("38466", "2026-06-24", "CASCAJO Camp. Sur", 14.0, "M3", "CAMP. SUR", 3, "GSI-3442", 8, 1, 1, 0.0, "Pendiente", None),
        ("38467", "2026-06-24", "ARENA GRUESA Camp. Sur", 14.0, "M3", "CAMP. SUR", 3, "GSI-3442", 9, 1, 1, 0.0, "Pendiente", None),
        ("38468", "2026-06-24", "PIEDRA 3/4 Camp. Sur", 14.0, "M3", "CAMP. SUR", 3, "GSI-3442", 3, 1, 1, 0.0, "Pendiente", None),
        ("J.DEERE", "2026-06-25", "ALQUILER RETROEXCAVADORA Camp. Sur", 8.0, "HORA", "CAMP. SUR", 3, "RETROEXCAVADORA CASE #1", 6, 2, 1, 8.0, "Pendiente", None),
        ("38572", "2026-06-25", "CASCAJO Camp. Sur", 14.0, "M3", "CAMP. SUR", 3, "GRD-0900", 8, 3, 1, 0.0, "Pendiente", None),
        ("38573", "2026-06-25", "SUB BASE Camp. Sur", 14.0, "M3", "CAMP. SUR", 3, "GRD-0900", 5, 3, 1, 0.0, "Pendiente", None),
        ("34960", "2026-06-26", "CASCAJO Sani Aurora", 14.0, "M3", "SANI AURORA", 3, "ESI-3413", 8, 1, 1, 0.0, "Pendiente", None),
        ("38579", "2026-06-26", "DESALOJO Sani Aurora", 1.0, "VIAJE", "SANI AURORA", 3, "GRD-0900", 10, 3, 1, 1.5, "Pendiente", None),
        ("38578", "2026-06-26", "ARENA GRUESA Camp. Sur", 14.0, "M3", "CAMP. SUR", 3, "GRD-0900", 9, 3, 1, 0.0, "Pendiente", None),
        ("38576", "2026-06-26", "CASCAJO Camp. Sur", 14.0, "M3", "CAMP. SUR", 3, "GRD-0900", 8, 3, 1, 0.0, "Pendiente", None),
        ("38577", "2026-06-26", "DESALOJO Camp. Sur", 1.0, "VIAJE", "CAMP. SUR", 3, "GRD-0900", 10, 3, 1, 1.5, "Pendiente", None),
        ("38580", "2026-06-26", "PIEDRA 3/4 Camp. Sur", 14.0, "M3", "CAMP. SUR", 3, "GRD-0900", 3, 3, 1, 0.0, "Pendiente", None)
    ]

    guides_ripconciv = [
        ("1722", "2026-06-02", "ALQUILER EXCAVADORA HYUNDAI 215L Bosquira", 10.5, "HORA", "BOSQUIRA", 1, "EXCAVADORA HYUNDAI 215L #1", 7, 2, 1, 10.5, "Facturado", 2),
        ("1723", "2026-06-03", "ALQUILER EXCAVADORA HYUNDAI 215L Bosquira", 9.5, "HORA", "BOSQUIRA", 1, "EXCAVADORA HYUNDAI 215L #1", 7, 2, 1, 9.5, "Facturado", 2),
        ("1724", "2026-06-04", "ALQUILER EXCAVADORA HYUNDAI 215L Bosquira", 9.0, "HORA", "BOSQUIRA", 1, "EXCAVADORA HYUNDAI 215L #1", 7, 2, 1, 9.0, "Facturado", 2),
        ("1725", "2026-06-05", "ALQUILER EXCAVADORA HYUNDAI 215L Bosquira", 10.0, "HORA", "BOSQUIRA", 1, "EXCAVADORA HYUNDAI 215L #1", 7, 2, 1, 10.0, "Facturado", 2),
        ("1726", "2026-06-06", "ALQUILER EXCAVADORA HYUNDAI 215L Bosquira", 5.0, "HORA", "BOSQUIRA", 1, "EXCAVADORA HYUNDAI 215L #1", 7, 2, 1, 5.0, "Facturado", 2),
        ("1728", "2026-06-08", "ALQUILER EXCAVADORA HYUNDAI 215L Bosquira", 7.0, "HORA", "BOSQUIRA", 1, "EXCAVADORA HYUNDAI 215L #1", 7, 2, 1, 7.0, "Pendiente", None),
        ("1730", "2026-06-10", "ALQUILER EXCAVADORA HYUNDAI 215L Bosquira", 14.0, "HORA", "BOSQUIRA", 1, "EXCAVADORA HYUNDAI 215L #1", 7, 2, 1, 14.0, "Pendiente", None)
    ]

    all_guides = guides_hydriapac + guides_ripconciv
    
    for g in all_guides:
        cursor.execute("""
        INSERT OR IGNORE INTO work_guides (guide_number, guide_date, description, quantity, unit, project, contact_id, plate_code, product_id, driver_id, signature_detected, hours_worked, billing_status, invoice_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, g)

    # Seed Users
    users = [
        ("admin", "admin123", "Admin"),
        ("supervisor", "super123", "Supervisor"),
        ("facturador", "fact123", "Facturador")
    ]
    cursor.executemany("""
    INSERT OR IGNORE INTO users (username, password, role)
    VALUES (?, ?, ?)
    """, users)

    # Seed Schedules (Demo data for July 2026)
    cursor.execute("SELECT COUNT(*) FROM schedules")
    if cursor.fetchone()[0] == 0:
        schedules = [
            (1, "ESI-3413", "2026-07-05", "2026-07-08", 8.0, "AURORA", 1, "Desalojo de material en obra Aurora"),
            (2, "XBP-719", "2026-07-10", "2026-07-12", 6.5, "CAMP. SUR", 3, "Carga y acarreo de sub-base"),
            (3, "GRD-0900", "2026-07-15", "2026-07-15", 9.0, "ESPOL", 2, "Carga de arena gruesa")
        ]
        cursor.executemany("""
        INSERT INTO schedules (driver_id, plate_code, start_date, end_date, planned_hours, project, contact_id, description)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, schedules)

    # Update PostgreSQL serial sequences to match max explicit IDs
    if os.getenv("SUPABASE_DB_URL"):
        cursor.execute("SELECT setval('contacts_id_seq', (SELECT MAX(id) FROM contacts));")
        cursor.execute("SELECT setval('drivers_id_seq', (SELECT MAX(id) FROM drivers));")
        cursor.execute("SELECT setval('products_id_seq', (SELECT MAX(id) FROM products));")
        cursor.execute("SELECT setval('invoices_id_seq', (SELECT MAX(id) FROM invoices));")

    conn.commit()

if __name__ == "__main__":
    init_db()


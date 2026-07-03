import os
import unittest
from fastapi.testclient import TestClient

# Ensure we import our local backend modules
import sys
sys.path.append(os.path.dirname(__file__))

from backend.main import app
from backend.database import init_db

class TestTransjulcampBackend(unittest.TestCase):
    
    @classmethod
    def setUpClass(cls):
        # Clean tables to ensure fresh seed data for tests (safely bypasses Windows file locks)
        import sqlite3
        from backend.database import DATABASE_PATH
        try:
            conn = sqlite3.connect(DATABASE_PATH)
            cursor = conn.cursor()
            cursor.execute("PRAGMA foreign_keys = OFF;")
            cursor.execute("SELECT name FROM sqlite_master WHERE type='table';")
            tables = [r[0] for r in cursor.fetchall() if r[0] != "sqlite_sequence"]
            for table in tables:
                cursor.execute(f"DROP TABLE IF EXISTS {table};")
            conn.commit()
            conn.close()
        except Exception as e:
            print(f"Error cleaning database tables: {e}")
            
        # Initialize database to make sure seed data is fresh
        init_db()
        cls.client = TestClient(app)
        cls.client.headers.update({"Authorization": "Bearer mock-token-admin-Admin"})


    def test_01_dashboard_kpis(self):
        """Test that KPIs are retrieved correctly on startup"""
        response = self.client.get("/api/dashboard/kpis")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        
        # Check presence of expected KPI fields
        self.assertIn("total_billed", data)
        self.assertIn("total_pending", data)
        self.assertIn("active_machinery", data)
        self.assertIn("unbilled_guides", data)
        self.assertIn("top_debtors", data)
        
        # Initial seeded active machinery should be 7
        self.assertEqual(data["active_machinery"], 7)

    def test_02_dashboard_charts(self):
        """Test that charts datasets are returned"""
        response = self.client.get("/api/dashboard/charts")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        
        self.assertIn("driver_productivity", data)
        self.assertIn("machinery_productivity", data)
        self.assertIn("revenue_per_vehicle", data)
        
        # Check that we have records seeded
        self.assertTrue(len(data["driver_productivity"]) > 0)
        self.assertTrue(len(data["machinery_productivity"]) > 0)
        self.assertTrue(len(data["revenue_per_vehicle"]) > 0)

    def test_03_products_crud(self):
        """Test CRUD operations on Products and margins logic"""
        # Create a new product
        new_prod = {
            "name": "TEST ARENA DE RIO",
            "cost": 10.00,
            "margin": 33.33,
            "profit": 5.00,
            "price": 15.00
        }
        
        # 1. Create
        response = self.client.post("/api/products", json=new_prod)
        self.assertEqual(response.status_code, 200)
        prod_id = response.json()["id"]
        
        # 2. Read and verify
        response = self.client.get("/api/products")
        self.assertEqual(response.status_code, 200)
        products = response.json()
        saved_prod = next(p for p in products if p["id"] == prod_id)
        self.assertEqual(saved_prod["name"], "TEST ARENA DE RIO")
        self.assertAlmostEqual(saved_prod["price"], 15.00)
        
        # 3. Update
        updated_prod = {
            "name": "TEST ARENA DE RIO MODIFICADA",
            "cost": 10.00,
            "margin": 50.00,
            "profit": 10.00,
            "price": 20.00
        }
        response = self.client.put(f"/api/products/{prod_id}", json=updated_prod)
        self.assertEqual(response.status_code, 200)
        
        # Verify update
        response = self.client.get("/api/products")
        saved_prod = next(p for p in response.json() if p["id"] == prod_id)
        self.assertEqual(saved_prod["name"], "TEST ARENA DE RIO MODIFICADA")
        self.assertAlmostEqual(saved_prod["price"], 20.00)
        
        # 4. Delete
        response = self.client.delete(f"/api/products/{prod_id}")
        self.assertEqual(response.status_code, 200)

    def test_03_b_contacts_crud(self):
        """Test CRUD operations on Contacts (Clients) and SRI fields"""
        new_contact = {
            "name": "TEST CLIENTE SRI S.A.",
            "ruc": "1792983742001",
            "email": "facturas@testclient.com",
            "phone": "022555666",
            "address": "Av. de los Granados, Quito",
            "credit_limit": 5000.00,
            "current_balance": 1500.00
        }

        # 1. Create
        response = self.client.post("/api/contacts", json=new_contact)
        self.assertEqual(response.status_code, 200)
        contact_id = response.json()["id"]

        # 2. Read and verify
        response = self.client.get("/api/contacts")
        self.assertEqual(response.status_code, 200)
        contacts = response.json()
        saved = next(c for c in contacts if c["id"] == contact_id)
        self.assertEqual(saved["name"], "TEST CLIENTE SRI S.A.")
        self.assertEqual(saved["ruc"], "1792983742001")
        self.assertEqual(saved["email"], "facturas@testclient.com")
        self.assertAlmostEqual(saved["credit_limit"], 5000.00)
        self.assertAlmostEqual(saved["current_balance"], 1500.00)

        # 3. Update
        updated_contact = {
            "name": "TEST CLIENTE SRI S.A. MODIFICADO",
            "ruc": "1792983742001",
            "email": "facturas.nuevas@testclient.com",
            "phone": "022555666",
            "address": "Av. de los Granados, Quito",
            "credit_limit": 8000.00,
            "current_balance": 1500.00
        }
        response = self.client.put(f"/api/contacts/{contact_id}", json=updated_contact)
        self.assertEqual(response.status_code, 200)

        # Verify update
        response = self.client.get("/api/contacts")
        saved = next(c for c in response.json() if c["id"] == contact_id)
        self.assertEqual(saved["name"], "TEST CLIENTE SRI S.A. MODIFICADO")
        self.assertEqual(saved["email"], "facturas.nuevas@testclient.com")
        self.assertAlmostEqual(saved["credit_limit"], 8000.00)

        # 4. Delete
        response = self.client.delete(f"/api/contacts/{contact_id}")
        self.assertEqual(response.status_code, 200)

    def test_04_ocr_fallback(self):
        """Test that uploaded files invoke fallback OCR and matching entity IDs"""
        # Create a dummy file with size close to sample image size to trigger sample fallback
        # Let's create a temporary file with ~195,000 bytes
        dummy_path = "temp_dummy_guide.jpg"
        with open(dummy_path, "wb") as f:
            f.write(b"\0" * 195600)
            
        try:
            with open(dummy_path, "rb") as f:
                response = self.client.post("/api/upload", files={"file": ("dummy_guide.jpg", f, "image/jpeg")})
            
            self.assertEqual(response.status_code, 200)
            extracted = response.json()
            
            # Verify details match the seeded sample fallback guide
            self.assertEqual(extracted["guide_number"], "000236301")
            self.assertEqual(extracted["plate_code"], "ESI-3413")
            self.assertEqual(extracted["driver_name"], "JORGE MOREIRA")
            
            # Verify the matched DB IDs
            self.assertEqual(extracted["contact_id"], 1) # RIPCONCIV CONSTRUCTORA
            self.assertEqual(extracted["driver_id"], 1)  # JORGE MOREIRA
            self.assertEqual(extracted["product_id"], 10) # DESALOJO
            
        finally:
            if os.path.exists(dummy_path):
                os.remove(dummy_path)

    def test_04_b_ocr_fallback_sample_2(self):
        """Test that uploaded files of size close to sample 2 trigger sample 2 fallback data"""
        dummy_path = "temp_dummy_guide_2.jpg"
        with open(dummy_path, "wb") as f:
            f.write(b"\0" * 162700)
            
        try:
            with open(dummy_path, "rb") as f:
                response = self.client.post("/api/upload", files={"file": ("dummy_guide_2.jpg", f, "image/jpeg")})
            
            self.assertEqual(response.status_code, 200)
            extracted = response.json()
            
            # Verify details match the second seeded sample fallback guide
            self.assertEqual(extracted["guide_number"], "000038584")
            self.assertEqual(extracted["plate_code"], "GRD-0900")
            self.assertEqual(extracted["project"], "ESPOL")
            self.assertEqual(extracted["unit"], "M3")
            self.assertEqual(extracted["quantity"], 13.84)
            
            # Verify the matched DB IDs
            self.assertEqual(extracted["contact_id"], 1) # RIPCONCIV CONSTRUCTORA
            self.assertEqual(extracted["driver_id"], 3)  # MARIO PINTO (assigned to GRD-0900)
            self.assertEqual(extracted["product_id"], 9)  # ARENA GRUESA
            
        finally:
            if os.path.exists(dummy_path):
                os.remove(dummy_path)

    def test_04_c_ocr_fallback_sample_3(self):
        """Test that uploaded files of size close to sample 3 trigger sample 3 fallback data"""
        dummy_path = "temp_dummy_guide_3.jpg"
        with open(dummy_path, "wb") as f:
            f.write(b"\0" * 138600)
            
        try:
            with open(dummy_path, "rb") as f:
                response = self.client.post("/api/upload", files={"file": ("dummy_guide_3.jpg", f, "image/jpeg")})
            
            self.assertEqual(response.status_code, 200)
            extracted = response.json()
            
            # Verify details match the third seeded sample fallback guide
            self.assertEqual(extracted["guide_number"], "000038528")
            self.assertEqual(extracted["plate_code"], "XBP-719")
            self.assertEqual(extracted["project"], "MALECON AURORA")
            self.assertEqual(extracted["unit"], "M3")
            self.assertEqual(extracted["quantity"], 13.0)
            
            # Verify the matched DB IDs
            self.assertEqual(extracted["contact_id"], 1) # RIPCONCIV CONSTRUCTORA
            self.assertEqual(extracted["driver_id"], 2)  # FERNANDO ALVARADO (assigned to XBP-719)
            self.assertEqual(extracted["product_id"], 5)  # SUB BASE (Piedra Base mapped to product 5)
            
        finally:
            if os.path.exists(dummy_path):
                os.remove(dummy_path)


    def test_05_mass_billing_and_approvals(self):
        """Test mass billing, supervisor approvals, and client balance updates"""
        # Load all guides
        response = self.client.get("/api/guides")
        guides = response.json()
        
        # Find unbilled ("Pendiente") guides for client 3 (Hydriapac)
        hydriapac_guides = [g["id"] for g in guides if g["contact_id"] == 3 and g["billing_status"] == "Pendiente"]
        self.assertTrue(len(hydriapac_guides) > 0)
        
        # 1. Generate Invoice (Draft)
        payload = {
            "guide_ids": hydriapac_guides,
            "iva_percentage": 15.0
        }
        response = self.client.post("/api/invoices/generate-mass", json=payload)
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertIn("invoices", data)
        self.assertEqual(len(data["invoices"]), 1)
        invoice_id = data["invoices"][0]["invoice_id"]
        
        # Check that guides are now 'En Proceso'
        response = self.client.get("/api/guides")
        linked_guides = [g for g in response.json() if g["id"] in hydriapac_guides]
        for g in linked_guides:
            self.assertEqual(g["billing_status"], "En Proceso")
            self.assertEqual(g["invoice_id"], invoice_id)
            
        # 1.b Test Edit Invoice (before approval)
        edit_payload = {
            "client_id": 3,
            "invoice_date": "2026-06-30",
            "subtotal": 1000.0,
            "iva_percentage": 15.0,
            "iva": 150.0,
            "total": 1150.0
        }
        response = self.client.put(f"/api/invoices/{invoice_id}", json=edit_payload)
        self.assertEqual(response.status_code, 200)
        
        # Verify the edited values
        response = self.client.get(f"/api/invoices/{invoice_id}")
        self.assertEqual(response.status_code, 200)
        inv_data = response.json()["invoice"]
        self.assertEqual(inv_data["subtotal"], 1000.0)
        self.assertEqual(inv_data["total"], 1150.0)
        
        # 1.c Test Delete Invoice (before approval)
        response = self.client.delete(f"/api/invoices/{invoice_id}")
        self.assertEqual(response.status_code, 200)
        
        # Verify invoice is deleted
        response = self.client.get(f"/api/invoices/{invoice_id}")
        self.assertEqual(response.status_code, 404)
        
        # Verify that guides reverted to 'Pendiente' and invoice_id is unlinked
        response = self.client.get("/api/guides")
        linked_guides = [g for g in response.json() if g["id"] in hydriapac_guides]
        for g in linked_guides:
            self.assertEqual(g["billing_status"], "Pendiente")
            self.assertIsNone(g["invoice_id"])
            
        # 1.d Re-generate the Invoice to continue original test flow
        response = self.client.post("/api/invoices/generate-mass", json=payload)
        self.assertEqual(response.status_code, 200)
        invoice_id = response.json()["invoices"][0]["invoice_id"]

        # Get client current balance before approval
        response = self.client.get("/api/contacts")
        clients = response.json()
        hydriapac_client = next(c for c in clients if c["id"] == 3)
        balance_before = hydriapac_client["current_balance"]

        # 2. Approve Invoice (Supervisor)
        response = self.client.put(f"/api/invoices/{invoice_id}/status", json={"approval_status": "Aprobada"})
        self.assertEqual(response.status_code, 200)
        
        # Check that guides are now 'Facturado'
        response = self.client.get("/api/guides")
        linked_guides = [g for g in response.json() if g["id"] in hydriapac_guides]
        for g in linked_guides:
            self.assertEqual(g["billing_status"], "Facturado")
            
        # Check that client balance was increased by the invoice total
        response = self.client.get("/api/invoices")
        inv = next(i for i in response.json() if i["id"] == invoice_id)
        invoice_total = inv["total"]
        
        response = self.client.get("/api/contacts")
        hydriapac_client = next(c for c in response.json() if c["id"] == 3)
        self.assertAlmostEqual(hydriapac_client["current_balance"], balance_before + invoice_total)

        # 3. SRI Emission (Facturador)
        response = self.client.post(f"/api/invoices/{invoice_id}/emit-sri")
        self.assertEqual(response.status_code, 200)
        sri_data = response.json()
        self.assertIn("access_key", sri_data)
        self.assertEqual(len(sri_data["access_key"]), 49) # Valid 49-digit access key
        self.assertIn("xml", sri_data)

        # Verify SRI status in invoices list
        response = self.client.get("/api/invoices")
        updated_inv = next(i for i in response.json() if i["id"] == invoice_id)
        self.assertEqual(updated_inv["sri_status"], "Autorizada")
        self.assertEqual(updated_inv["sri_access_key"], sri_data["access_key"])

        # 4. Record Payment with withholdings (Cobros)
        payment_payload = {
            "amount_paid": invoice_total * 0.9, # 90% paid in cash
            "withholding_rent": invoice_total * 0.08, # 8% rent
            "withholding_iva": invoice_total * 0.02 # 2% IVA
        }
        
        response = self.client.post(f"/api/invoices/{invoice_id}/pay", json=payment_payload)
        self.assertEqual(response.status_code, 200)
        pay_res = response.json()
        self.assertEqual(pay_res["payment_status"], "Pagada")
        self.assertAlmostEqual(pay_res["amount_pending"], 0.0)
        
        # Verify client balance decreased back to balance_before
        response = self.client.get("/api/contacts")
        hydriapac_client = next(c for c in response.json() if c["id"] == 3)
        self.assertAlmostEqual(hydriapac_client["current_balance"], balance_before)

    def test_06_login_success(self):
        """Test successful login returns mock token"""
        payload = {"username": "admin", "password": "admin123"}
        # Make request without the default client header for this one
        temp_client = TestClient(app)
        response = temp_client.post("/api/login", json=payload)
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertIn("token", data)
        self.assertEqual(data["username"], "admin")
        self.assertEqual(data["role"], "Admin")

    def test_07_login_failure(self):
        """Test invalid credentials returns 400"""
        payload = {"username": "admin", "password": "wrongpassword"}
        temp_client = TestClient(app)
        response = temp_client.post("/api/login", json=payload)
        self.assertEqual(response.status_code, 400)

    def test_08_rbac_supervisor_restricted(self):
        """Test that Supervisor role cannot access collections pay endpoint or catalog writes"""
        supervisor_client = TestClient(app)
        supervisor_client.headers.update({"Authorization": "Bearer mock-token-supervisor-Supervisor"})
        
        # Try to pay (Cobros) -> should return 403
        response = supervisor_client.post("/api/invoices/1/pay", json={"amount_paid": 100.0})
        self.assertEqual(response.status_code, 403)
        
        # Try to create a product -> should return 403
        new_prod = {
            "name": "SUPERVISOR PROD", "cost": 10.00, "margin": 10.00, "profit": 1.00, "price": 11.00
        }
        response = supervisor_client.post("/api/products", json=new_prod)
        self.assertEqual(response.status_code, 403)

    def test_09_rbac_facturador_restricted(self):
        """Test that Facturador role cannot approve/reject invoices or write to catalogs"""
        fact_client = TestClient(app)
        fact_client.headers.update({"Authorization": "Bearer mock-token-facturador-Facturador"})
        
        # Try to approve -> should return 403
        response = fact_client.put("/api/invoices/1/status", json={"approval_status": "Aprobada"})
        self.assertEqual(response.status_code, 403)
        
        # Try to create a driver -> should return 403
        new_driver = {
            "name": "TEST DRIVER", "dni": "0000000000", "phone": "", "address": "", "status": "Activo"
        }
        response = fact_client.post("/api/drivers", json=new_driver)
        self.assertEqual(response.status_code, 403)

    def test_10_schedules_crud(self):
        """Test CRUD operations on Schedules (planning)"""
        new_schedule = {
            "driver_id": 1,
            "plate_code": "ESI-3413",
            "start_date": "2026-07-20",
            "end_date": "2026-07-22",
            "planned_hours": 8.0,
            "project": "TEST PROJECT",
            "contact_id": 1,
            "description": "Test scheduling description"
        }

        # 1. Create
        response = self.client.post("/api/schedules", json=new_schedule)
        self.assertEqual(response.status_code, 200)
        schedule_id = response.json()["id"]

        # 2. Read and verify
        response = self.client.get("/api/schedules")
        self.assertEqual(response.status_code, 200)
        schedules = response.json()
        saved = next(s for s in schedules if s["id"] == schedule_id)
        self.assertEqual(saved["project"], "TEST PROJECT")
        self.assertEqual(saved["driver_name"], "JORGE MOREIRA")
        self.assertEqual(saved["client_name"], "RIPCONCIV CONSTRUCTORA")

        # 3. Update
        updated_schedule = {
            "driver_id": 1,
            "plate_code": "ESI-3413",
            "start_date": "2026-07-20",
            "end_date": "2026-07-25",
            "planned_hours": 9.5,
            "project": "TEST PROJECT UPDATED",
            "contact_id": 1,
            "description": "Test scheduling description updated"
        }
        response = self.client.put(f"/api/schedules/{schedule_id}", json=updated_schedule)
        self.assertEqual(response.status_code, 200)

        # Verify update
        response = self.client.get("/api/schedules")
        schedules = response.json()
        saved = next(s for s in schedules if s["id"] == schedule_id)
        self.assertEqual(saved["project"], "TEST PROJECT UPDATED")
        self.assertEqual(saved["planned_hours"], 9.5)

        # 4. Delete
        response = self.client.delete(f"/api/schedules/{schedule_id}")
        self.assertEqual(response.status_code, 200)

        # Verify deletion
        response = self.client.get("/api/schedules")
        schedules = response.json()
        self.assertFalse(any(s["id"] == schedule_id for s in schedules))

if __name__ == "__main__":
    unittest.main()

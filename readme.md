# Fabrica – Server Side

Backend API for **Fabrica**, powering authentication, product management, order processing, tracking, and role-based authorization.

---

## 🛠 Tech Stack

- **Node.js**
- **Express.js**
- **MongoDB (Atlas)**
- **Firebase Admin SDK**
- **JWT Authentication**
- **Cors**
- **Dotenv**

---

## 🔐 Authentication & Authorization

- JWT-based route protection
- Firebase token verification
- Role-based middleware:
  - `verifyJWT`
  - `verifyADMIN`
  - `verifyMANAGER`

---

## 👥 Roles & Permissions

### Customer

- Place orders
- View own orders
- Track order progress

### Manager

- Add / update products
- Approve orders
- Add tracking updates

### Admin

- Manage users & roles
- Approve manager requests
- Suspend users
- Full system access

---

## 📦 API Features

- Product CRUD with pagination & filtering
- Category-based product browsing
- Order placement & approval
- Order tracking timeline
- User role management
- Secure data validation

---

## 🚀 Live API

👉 **Backend URL:** [Fabrica-Server](https://garments-server-side-ten.vercel.app)

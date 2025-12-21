require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const admin = require("firebase-admin");
const port = process.env.PORT || 3000;
//const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString("utf-8");
//const serviceAccount = JSON.parse(decoded);
const serviceAccount = require("./serviceAccountKey.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const app = express();
// middleware
app.use(
  cors({
    origin: [process.env.CLIENT_DOMAIN],
    credentials: true,
    optionSuccessStatus: 200,
  })
);
app.use(express.json());

// jwt middlewares
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(" ")[1];
  //console.log(token);
  if (!token) return res.status(401).send({ message: "Unauthorized Access!" });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.tokenEmail = decoded.email;
    //console.log(decoded);
    next();
  } catch (err) {
    console.log(err);
    return res.status(401).send({ message: "Unauthorized Access!", err });
  }
};

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});
async function run() {
  try {
    const db = client.db("productsDB");
    const productsCollection = db.collection("products");
    const ordersCollection = db.collection("orders");
    const usersCollection = db.collection("users");
    const sellerRequestsCollection = db.collection("sellerRequests");

    // role middlewares
    const verifyADMIN = async (req, res, next) => {
      const email = req.tokenEmail;
      const user = await usersCollection.findOne({ email });
      if (user?.role !== "admin")
        return res
          .status(403)
          .send({ message: "Admin only Actions!", role: user?.role });

      next();
    };
    const verifySELLER = async (req, res, next) => {
      const email = req.tokenEmail;
      const user = await usersCollection.findOne({ email });
      if (user?.role !== "seller")
        return res
          .status(403)
          .send({ message: "Seller only Actions!", role: user?.role });

      next();
    };

    // Save a product data in db
    app.post("/products", verifyJWT, verifySELLER, async (req, res) => {
      const {
        image,
        name,
        description,
        quantity,
        price,
        category,
        minimumOrder,
        seller,
      } = req.body;

      const productData = {
        image,
        name,
        description,
        quantity: Number(quantity),
        price: Number(price),
        minimumOrder: Number(minimumOrder),
        category,
        seller,
        date: new Date(),
      };

      const result = await productsCollection.insertOne(productData);
      res.send(result);
    });

    // get all products from db
    app.get("/products", async (req, res) => {
      const result = await productsCollection.find().toArray();
      res.send(result);
    });

    // get a product from db
    app.get("/products/:id", async (req, res) => {
      const id = req.params.id;
      const result = await productsCollection.findOne({
        _id: new ObjectId(id),
      });
      res.send(result);
    });
    // latest data
    app.get("/latest-products", async (req, res) => {
      const result = await productsCollection
        .find()
        .sort({ date: "desc" })
        .limit(6)
        .toArray();
      res.send(result);
    });

    // Payment endpoints
    app.post("/create-checkout-session", async (req, res) => {
      const order = req.body;
      console.log(order);

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: order.productName,
                images: [order.image],
              },
              unit_amount: order.unitPrice * 100,
            },
            quantity: order.quantity,
          },
        ],
        mode: "payment",
        customer_email: order.customer.email,

        // 🔴 STORE EVERYTHING YOU NEED
        metadata: {
          productId: order.productId,
          quantity: order.quantity,
          unitPrice: order.unitPrice,
          totalPrice: order.totalPrice,
          customerEmail: order.customer.email,
          customerName: order.customer.name,
          customerImage: order.customer.image,

          paymentMethod: "online",
        },

        success_url: `${process.env.CLIENT_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.CLIENT_DOMAIN}/product/${order.productId}`,
      });

      res.send({ url: session.url });
    });

    // successful payment
    app.post("/payment-success", async (req, res) => {
      const { sessionId } = req.body;

      const session = await stripe.checkout.sessions.retrieve(sessionId);
      console.log(session);

      if (session.payment_status !== "paid") {
        return res.status(400).send({ message: "Payment not completed" });
      }

      const productId = session.metadata.productId;
      const quantity = Number(session.metadata.quantity);

      // Prevent duplicate order
      const existingOrder = await ordersCollection.findOne({
        transactionId: session.payment_intent,
      });

      if (existingOrder) {
        return res.send(existingOrder);
      }

      const product = await productsCollection.findOne({
        _id: new ObjectId(productId),
      });

      if (!product) {
        return res.status(404).send({ message: "Product not found" });
      }

      // 🔒 Enforce min order & stock AGAIN (backend safety)
      if (quantity < product.minimumOrder || quantity > product.quantity) {
        return res.status(400).send({ message: "Invalid order quantity" });
      }

      // ✅ Create order
      const orderData = {
        productId,
        productName: product.name,
        category: product.category,
        image: product.image,
        description: product.description,
        unitPrice: product.price,
        quantity,
        totalPrice: session.amount_total / 100,
        paymentMethod: "online",
        paymentStatus: "paid",
        transactionId: session.payment_intent,
        seller: product.seller,
        customer: {
          email: session.customer_email,
          name: session.metadata.customerName,
          image: session.metadata.customerImage,
        },
        createdAt: new Date(),
        orderStatus: "pending",
      };

      const result = await ordersCollection.insertOne(orderData);

      // ✅ Update stock
      await productsCollection.updateOne(
        { _id: product._id },
        { $inc: { quantity: -quantity } }
      );

      res.send(result);
    });

    // save an order in db
    app.post("/orders", async (req, res) => {
      const order = req.body;

      if (order.paymentMethod !== "cod") {
        return res.status(400).send({ message: "Invalid payment method" });
      }

      const product = await productsCollection.findOne({
        _id: new ObjectId(order.productId),
      });

      if (!product) {
        return res.status(404).send({ message: "Product not found" });
      }

      if (
        order.quantity < product.minimumOrder ||
        order.quantity > product.quantity
      ) {
        return res.status(400).send({ message: "Invalid order quantity" });
      }

      const result = await ordersCollection.insertOne({
        ...order,
        createdAt: new Date(),
        orderStatus: "pending",
        paymentStatus: "pending",
      });

      await productsCollection.updateOne(
        { _id: product._id },
        { $inc: { quantity: -order.quantity } }
      );

      res.send(result);
    });

    // get all orders for a customer by email
    app.get("/my-orders", verifyJWT, async (req, res) => {
      const email = req.tokenEmail;

      const orders = await ordersCollection
        .find({ "customer.email": email })
        .sort({ createdAt: -1 })
        .toArray();

      res.send(orders);
    });

    // get all orders for a seller by email
    app.get(
      "/manage-orders/:email",
      verifyJWT,
      verifySELLER,
      async (req, res) => {
        console.log(req.user);
        const sellerEmail = req.params.email;

        const orders = await ordersCollection
          .find({ "seller.email": sellerEmail })
          .sort({ createdAt: -1 })
          .toArray();

        res.send(orders);
      }
    );

    // get all products for a seller by email
    app.get(
      "/my-inventory/:email",
      verifyJWT,
      verifySELLER,
      async (req, res) => {
        console.log(req.user);
        const sellerEmail = req.params.email;

        const products = await productsCollection
          .find({ "seller.email": sellerEmail })
          .sort({ date: -1 })
          .toArray();

        res.send(products);
      }
    );

    // save or update a user in db
    app.post("/user", async (req, res) => {
      const userData = req.body;
      userData.created_at = new Date().toISOString();
      userData.last_loggedIn = new Date().toISOString();
      userData.role = "customer";

      const query = {
        email: userData.email,
      };

      const alreadyExists = await usersCollection.findOne(query);
      console.log("User Already Exists---> ", !!alreadyExists);

      if (alreadyExists) {
        console.log("Updating user info......");
        const result = await usersCollection.updateOne(query, {
          $set: {
            last_loggedIn: new Date().toISOString(),
          },
        });
        return res.send(result);
      }

      console.log("Saving new user info......");
      const result = await usersCollection.insertOne(userData);
      res.send(result);
    });

    // get a user's role
    app.get("/user/role", verifyJWT, async (req, res) => {
      const result = await usersCollection.findOne({ email: req.tokenEmail });
      res.send({ role: result?.role });
    });

    // save become-seller request
    app.post("/become-seller", verifyJWT, async (req, res) => {
      const email = req.tokenEmail;
      const alreadyExists = await sellerRequestsCollection.findOne({ email });
      if (alreadyExists)
        return res
          .status(409)
          .send({ message: "Already requested, wait koro." });

      const result = await sellerRequestsCollection.insertOne({ email });
      res.send(result);
    });

    // get all seller requests for admin
    app.get("/seller-requests", verifyJWT, verifyADMIN, async (req, res) => {
      const result = await sellerRequestsCollection.find().toArray();
      res.send(result);
    });

    // get all users for admin
    app.get("/users", verifyJWT, verifyADMIN, async (req, res) => {
      const adminEmail = req.tokenEmail;
      const result = await usersCollection
        .find({ email: { $ne: adminEmail } })
        .toArray();
      res.send(result);
    });

    // update a user's role
    app.patch("/update-role", verifyJWT, verifyADMIN, async (req, res) => {
      const { email, role } = req.body;
      const result = await usersCollection.updateOne(
        { email },
        { $set: { role } }
      );
      await sellerRequestsCollection.deleteOne({ email });

      res.send(result);
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Hello from Server..");
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

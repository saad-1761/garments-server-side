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
      const { image, name, description, quantity, price, category, seller } =
        req.body;
      //adding date
      const date = new Date().toISOString().split("T")[0];

      const productData = {
        image,
        name,
        description,
        quantity: parseInt(quantity),
        price: parseFloat(price),
        category,
        seller,
        date,
      };

      console.log(productData);
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
      const paymentInfo = req.body;
      //console.log(paymentInfo);
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: paymentInfo?.name,
                description: paymentInfo?.description,
                images: [paymentInfo.image],
              },
              unit_amount: paymentInfo?.price * 100,
            },
            quantity: paymentInfo?.quantity,
          },
        ],
        customer_email: paymentInfo?.customer?.email,
        mode: "payment",
        metadata: {
          productId: paymentInfo?.productId,
          customer: paymentInfo?.customer.email,
        },
        success_url: `${process.env.CLIENT_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.CLIENT_DOMAIN}/product/${paymentInfo?.productId}`,
      });
      res.send({ url: session.url });
    });

    app.post("/payment-success", async (req, res) => {
      const { sessionId } = req.body;
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      const product = await productsCollection.findOne({
        _id: new ObjectId(session.metadata.productId),
      });
      const order = await ordersCollection.findOne({
        transactionId: session.payment_intent,
      });

      if (session.status === "complete" && product && !order) {
        // save order data in db
        const orderInfo = {
          productId: session.metadata.productId,
          transactionId: session.payment_intent,
          customer: session.metadata.customer,
          status: "pending",
          seller: product.seller,
          name: product.name,
          category: product.category,
          quantity: 1,
          price: session.amount_total / 100,
          image: product?.image,
        };
        const result = await ordersCollection.insertOne(orderInfo);
        // update product quantity
        await productsCollection.updateOne(
          {
            _id: new ObjectId(session.metadata.productId),
          },
          { $inc: { quantity: -1 } }
        );

        return res.send({
          transactionId: session.payment_intent,
          orderId: result.insertedId,
        });
      }
      res.send(
        res.send({
          transactionId: session.payment_intent,
          orderId: order._id,
        })
      );
    });

    // get all orders for a customer by email
    app.get("/my-orders", verifyJWT, async (req, res) => {
      const result = await ordersCollection
        .find({ customer: req.tokenEmail })
        .toArray();
      res.send(result);
    });

    // get all orders for a seller by email
    app.get(
      "/manage-orders/:email",
      verifyJWT,
      verifySELLER,
      async (req, res) => {
        const email = req.params.email;

        const result = await ordersCollection
          .find({ "seller.email": email })
          .toArray();
        res.send(result);
      }
    );

    // get all products for a seller by email
    app.get(
      "/my-inventory/:email",
      verifyJWT,
      verifySELLER,
      async (req, res) => {
        const email = req.params.email;

        const result = await productsCollection
          .find({ "seller.email": email })
          .toArray();
        res.send(result);
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

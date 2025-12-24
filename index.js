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
    origin: [process.env.CLIENT_DOMAIN, "http://localhost:5173"],
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
    const trackingCollection = db.collection("tracking");

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

    const verifyMANAGER = async (req, res, next) => {
      const email = req.tokenEmail;
      const user = await usersCollection.findOne({ email });
      if (user?.role !== "seller")
        return res
          .status(403)
          .send({ message: "Seller only Actions!", role: user?.role });

      next();
    };

    app.post("/products", verifyJWT, verifyMANAGER, async (req, res) => {
      try {
        const managerEmail = req.tokenEmail;

        const {
          image, // old support
          images = [], // new support
          name,
          description,
          quantity,
          price,
          category,
          minimumOrder,
          demoVideoLink = "",
          paymentOption = "cod", // "cod" | "payfirst"
          showOnHome = false,
          seller,
        } = req.body;

        const finalImages =
          Array.isArray(images) && images.length
            ? images
            : image
            ? [image]
            : [];

        const productData = {
          image: finalImages[0] || image || "",
          images: finalImages, // new (safe)
          name,
          description,
          quantity: Number(quantity),
          price: Number(price),
          minimumOrder: Number(minimumOrder),
          category,
          demoVideoLink,
          paymentOption,
          showOnHome: Boolean(showOnHome),
          seller: {
            name: seller?.name,
            email: managerEmail,
            image: seller?.image,
          },
          date: new Date(),
        };

        const result = await productsCollection.insertOne(productData);
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: err.message });
      }
    });

    //manager products list
    app.get("/manager/products", verifyJWT, verifyMANAGER, async (req, res) => {
      const email = req.tokenEmail;

      const products = await productsCollection
        .find({ "seller.email": email })
        .sort({ date: -1 })
        .toArray();

      res.send(products);
    });
    //delete manager product

    app.delete(
      "/manager/products/:id",
      verifyJWT,
      verifyMANAGER,
      async (req, res) => {
        const email = req.tokenEmail;
        const { id } = req.params;

        const product = await productsCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!product)
          return res.status(404).send({ message: "Product not found" });

        if (product?.seller?.email !== email) {
          return res.status(403).send({ message: "Forbidden" });
        }

        const result = await productsCollection.deleteOne({
          _id: new ObjectId(id),
        });
        res.send({ success: true, result });
      }
    );

    //update manager product
    app.patch(
      "/manager/products/:id",
      verifyJWT,
      verifyMANAGER,
      async (req, res) => {
        const email = req.tokenEmail;
        const { id } = req.params;

        const product = await productsCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!product)
          return res.status(404).send({ message: "Product not found" });

        if (product?.seller?.email !== email) {
          return res.status(403).send({ message: "Forbidden" });
        }

        const {
          name,
          description,
          category,
          price,
          quantity,
          minimumOrder,
          demoVideoLink,
          paymentOption,
          showOnHome,
          images, // optional
          image, // optional
        } = req.body;

        const finalImages =
          Array.isArray(images) && images.length
            ? images
            : image
            ? [image]
            : product.images?.length
            ? product.images
            : product.image
            ? [product.image]
            : [];

        const updateDoc = {
          $set: {
            ...(name ? { name } : {}),
            ...(description ? { description } : {}),
            ...(category ? { category } : {}),
            ...(price !== undefined ? { price: Number(price) } : {}),
            ...(quantity !== undefined ? { quantity: Number(quantity) } : {}),
            ...(minimumOrder !== undefined
              ? { minimumOrder: Number(minimumOrder) }
              : {}),
            ...(demoVideoLink !== undefined ? { demoVideoLink } : {}),
            ...(paymentOption ? { paymentOption } : {}),
            ...(showOnHome !== undefined
              ? { showOnHome: Boolean(showOnHome) }
              : {}),
            ...(finalImages?.length
              ? { images: finalImages, image: finalImages[0] }
              : {}),
          },
        };

        const result = await productsCollection.updateOne(
          { _id: new ObjectId(id) },
          updateDoc
        );

        res.send({ success: true, result });
      }
    );

    //manager orders list with status filter
    app.get("/manager/orders", verifyJWT, verifyMANAGER, async (req, res) => {
      const email = req.tokenEmail;
      const status = (req.query.status || "").toLowerCase(); // pending/approved/rejected

      const query = { "seller.email": email };
      if (status) query.orderStatus = status;

      const orders = await ordersCollection
        .find(query)
        .sort({ createdAt: -1 })
        .toArray();

      res.send(orders);
    });

    //approve order
    app.patch(
      "/manager/orders/:id/approve",
      verifyJWT,
      verifyMANAGER,
      async (req, res) => {
        const managerEmail = req.tokenEmail;
        const { id } = req.params;

        const order = await ordersCollection.findOne({ _id: new ObjectId(id) });
        if (!order) return res.status(404).send({ message: "Order not found" });

        if (order?.seller?.email !== managerEmail) {
          return res.status(403).send({ message: "Forbidden" });
        }

        if ((order?.orderStatus || "").toLowerCase() !== "pending") {
          return res
            .status(400)
            .send({ message: "Only pending orders can be approved" });
        }

        const result = await ordersCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { orderStatus: "approved", approvedAt: new Date() } }
        );

        res.send({ success: true, result });
      }
    );

    //reject order
    app.patch(
      "/manager/orders/:id/reject",
      verifyJWT,
      verifyMANAGER,
      async (req, res) => {
        const managerEmail = req.tokenEmail;
        const { id } = req.params;

        const order = await ordersCollection.findOne({ _id: new ObjectId(id) });
        if (!order) return res.status(404).send({ message: "Order not found" });

        if (order?.seller?.email !== managerEmail) {
          return res.status(403).send({ message: "Forbidden" });
        }

        if ((order?.orderStatus || "").toLowerCase() !== "pending") {
          return res
            .status(400)
            .send({ message: "Only pending orders can be rejected" });
        }

        const result = await ordersCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { orderStatus: "rejected", rejectedAt: new Date() } }
        );

        res.send({ success: true, result });
      }
    );
    //add tracking update (approved only)
    app.post(
      "/tracking/:orderId",
      verifyJWT,
      verifyMANAGER,
      async (req, res) => {
        const managerEmail = req.tokenEmail;
        const { orderId } = req.params;
        const { status, location, note } = req.body;

        if (!status)
          return res.status(400).send({ message: "Status is required" });

        const order = await ordersCollection.findOne({
          _id: new ObjectId(orderId),
        });
        if (!order) return res.status(404).send({ message: "Order not found" });

        if (order?.seller?.email !== managerEmail) {
          return res.status(403).send({ message: "Forbidden" });
        }

        if ((order?.orderStatus || "").toLowerCase() !== "approved") {
          return res
            .status(400)
            .send({ message: "Order must be approved first" });
        }

        // const trackingUpdate = {
        //   status,
        //   location: location || "",
        //   note: note || "",
        //   at: new Date(),
        //   addedBy: { email: managerEmail },
        // };

        const trackingUpdate = {
          status: status.trim(),
          location: (location || "").trim(),
          note: (note || "").trim(),
          at: new Date(),
          addedBy: { email: managerEmail },
        };
        // const result = await trackingCollection.updateOne(
        //   { orderId: new ObjectId(orderId) },
        //   { $push: { updates: trackingUpdate } },
        //   { upsert: true }
        // );
        const result = await trackingCollection.updateOne(
          { orderId: new ObjectId(orderId) },
          {
            $setOnInsert: {
              orderId: new ObjectId(orderId),
              createdAt: new Date(),
            },
            $push: { updates: trackingUpdate },
            $set: { updatedAt: new Date() },
          },
          { upsert: true }
        );

        res.send({ success: true, result });
      }
    );

    //get tracking
    app.get("/tracking/:orderId", verifyJWT, async (req, res) => {
      const email = req.tokenEmail;
      const { orderId } = req.params;

      const order = await ordersCollection.findOne({
        _id: new ObjectId(orderId),
      });
      if (!order) return res.status(404).send({ message: "Order not found" });

      // const isCustomer = order?.customer?.email === email;
      // const isManager = order?.seller?.email === email;

      const isCustomer =
        (order?.customer?.email || "").toLowerCase() === email.toLowerCase();

      const isManager =
        (order?.seller?.email || "").toLowerCase() === email.toLowerCase();

      if (!isCustomer && !isManager)
        return res.status(403).send({ message: "Forbidden" });

      const doc = await trackingCollection.findOne({
        orderId: new ObjectId(orderId),
      });
      res.send(doc?.updates || []);
    });

    // ✅ Customer: get my orders (for Track Orders list)
    app.get("/orders/me", verifyJWT, async (req, res) => {
      try {
        const email = req.tokenEmail;

        const result = await ordersCollection
          .find({ "customer.email": email })
          .sort({ createdAt: -1 }) // if you have createdAt; else use _id: -1
          .toArray();

        res.send(result);
      } catch (err) {
        console.error(err);
        res.status(500).send({ message: "Server error" });
      }
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

        // metadata
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
      verifyMANAGER,
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
      verifyMANAGER,
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
      const { name, email, image } = req.body;

      if (!email) {
        return res.status(400).send({ message: "Email is required" });
      }

      const query = { email };
      const alreadyExists = await usersCollection.findOne(query);
      console.log("User Already Exists---> ", !!alreadyExists);

      // ✅ If user already exists: only update last_loggedIn (keep role, created_at, etc.)
      if (alreadyExists) {
        console.log("Updating user info......");

        // Optional: if existing user missing name/image, fill them once (safe)
        const setObj = {
          last_loggedIn: new Date().toISOString(),
        };
        if (!alreadyExists?.name && name) setObj.name = name;
        if (!alreadyExists?.image && image) setObj.image = image;

        const result = await usersCollection.updateOne(query, { $set: setObj });
        return res.send(result);
      }

      // ✅ If new user: insert full record
      console.log("Saving new user info......");

      const userData = {
        name: name || "User",
        email,
        image: image || "",
        role: "customer",
        created_at: new Date().toISOString(),
        last_loggedIn: new Date().toISOString(),
      };

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

    //get all products for admin
    app.get("/all-product", verifyJWT, verifyADMIN, async (req, res) => {
      const result = await productsCollection.find().toArray();
      res.send(result);
    });
    ///////////////
    app.patch(
      "/products/:id/show-home",
      verifyJWT,
      verifyADMIN,
      async (req, res) => {
        const { id } = req.params;
        const { showOnHome, bumpDate } = req.body;

        const updateDoc = {
          $set: {
            showOnHome: !!showOnHome,
          },
        };

        // ✅ When showOnHome becomes true → set date to NOW so it appears latest
        if (showOnHome && bumpDate) {
          updateDoc.$set.date = new Date();
        }

        const result = await productsCollection.updateOne(
          { _id: new ObjectId(id) },
          updateDoc
        );

        res.send(result);
      }
    );

    app.patch("/products/:id", verifyJWT, verifyADMIN, async (req, res) => {
      const { id } = req.params;
      const data = req.body;

      const updateDoc = {
        $set: {
          name: data.name,
          description: data.description,
          price: Number(data.price),
          category: data.category,
          image: data.image,
          quantity: Number(data.quantity || 0),
          minimumOrder: Number(data.minimumOrder || 0),
          demoVideo: data.demoVideo || "",
          paymentOptions: data.paymentOptions || "",
          updatedAt: new Date(),
        },
      };

      const result = await productsCollection.updateOne(
        { _id: new ObjectId(id) },
        updateDoc
      );
      res.send(result);
    });

    app.delete("/products/:id", verifyJWT, verifyADMIN, async (req, res) => {
      const { id } = req.params;
      const result = await productsCollection.deleteOne({
        _id: new ObjectId(id),
      });
      res.send(result);
    });

    //////////////////////

    // get all orders for admin
    app.get("/all-order", verifyJWT, verifyADMIN, async (req, res) => {
      const result = await ordersCollection.find().toArray();
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

    ///////////////////////////////////////////
    //Update user-profile

    app.get("/users/me", verifyJWT, async (req, res) => {
      const email = req.tokenEmail;
      if (!email)
        return res.status(401).send({ message: "Unauthorized Access!" });

      const me = await usersCollection.findOne({ email });
      res.send(me);
    });

    app.patch("/users/:id", verifyJWT, async (req, res) => {
      const email = req.tokenEmail;
      if (!email)
        return res.status(401).send({ message: "Unauthorized Access!" });

      const { id } = req.params;
      const { name, image } = req.body;

      const updateDoc = {
        $set: {
          ...(name ? { name } : {}),
          ...(image ? { image } : {}),
          last_loggedIn: new Date().toISOString(),
        },
      };

      const result = await usersCollection.updateOne(
        { _id: new ObjectId(id), email },
        updateDoc
      );

      if (result.matchedCount === 0) {
        return res.status(403).send({ message: "Forbidden" });
      }

      res.send(result);
    });

    ///order cancel by user
    app.delete("/orders/:id", verifyJWT, async (req, res) => {
      const email = req.tokenEmail;
      const { id } = req.params;

      if (!email)
        return res.status(401).send({ message: "Unauthorized Access!" });

      const order = await ordersCollection.findOne({ _id: new ObjectId(id) });
      if (!order) return res.status(404).send({ message: "Order not found" });

      // must be the owner
      if (order?.customer?.email !== email) {
        return res.status(403).send({ message: "Forbidden" });
      }

      // only pending + unpaid can cancel
      if (
        (order?.orderStatus || "").toLowerCase() !== "pending" ||
        (order?.paymentStatus || "").toLowerCase() !== "pending"
      ) {
        return res
          .status(400)
          .send({ message: "Only pending unpaid orders can be cancelled" });
      }

      // ✅ restore stock
      await productsCollection.updateOne(
        { _id: new ObjectId(order.productId) },
        { $inc: { quantity: Number(order.quantity) } }
      );

      // ✅ delete the order
      const result = await ordersCollection.deleteOne({
        _id: new ObjectId(id),
      });

      res.send({ success: true, result });
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

import express from "express";
import path from "path";

const app = express();
const __dirname = path.resolve();

// Servir archivos estáticos desde /public
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Servidor escuchando en puerto " + PORT);
});

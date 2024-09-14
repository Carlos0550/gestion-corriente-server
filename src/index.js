const express = require("express");
const cors = require("cors");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");
require("dotenv").config();
const cron = require("node-cron");
const clientSupabase = require("./bd/clientSupabase.js");
const app = express();
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use(express.json());
dayjs.extend(utc);
dayjs.extend(timezone);
const argTime = dayjs().tz("America/Argentina/Buenos_Aires");

app.get("/", (req, res) => {
  res.send("Servidor levantado");
});

//Cron quitado ya que VERCEL no admite tareas programadas :(
// cron.schedule("0 0 * * *", async () => {
//   console.log("Ejecutando tarea CRON para los vencimientos");
//   try {
//     const hoy = argTime.format("YYYY-MM-DD");
//     const query = "UPDATE debts SET estado = 'vencido' WHERE duedate <= $1";
//     await clientSupabase.query("BEGIN");
//     const response = await clientSupabase.query(query, [hoy]);
//     console.log(response)
//     if (response.rowCount > 0) {
//       await clientSupabase.query("COMMIT");
//       console.log(
//         `Deudas actualizadas exitosamente, ${response.rowCount} filas fueron afectadas`
//       );
//     } else {
//       console.log("No hay deudas para actualizar en este momento.");
//     }
//   } catch (error) {
//     await clientSupabase.query("ROLLBACK");
//     console.error(
//       "Hubo un problema y no se pudo concretar la tarea CRON:",
//       error
//     );
//   }
// });

app.put("/get-expirations", async (req, res) => {
  try {
    const hoy = argTime.format("YYYY-MM-DD");
    const query = "UPDATE debts SET estado = 'vencido' WHERE duedate <= $1";
    await clientSupabase.query("BEGIN");
    const response = await clientSupabase.query(query, [hoy]);
    console.log(response);
    if (response.rowCount > 0) {
      await clientSupabase.query("COMMIT");
      console.log(
        `Deudas actualizadas exitosamente, ${response.rowCount} filas fueron afectadas`
      );
    } else {
      console.log("No hay deudas para actualizar en este momento.");
    }
  } catch (error) {
    await clientSupabase.query("ROLLBACK");
    console.error(
      "Hubo un problema y no se pudo concretar la tarea CRON:",
      error
    );
  }
});

app.post("/check-space", async (req, res) => {
  try {
    const result = await clientSupabase.query(`
      select
  sum(pg_database_size(pg_database.datname)) / (1024 * 1024) as db_size_mb
from pg_database;

    `);

    console.log(result);

    if (result.rows && result.rows.length > 0) {
      res.setHeader("Access-Control-Allow-Origin", "*"); // Asegúrate de que este encabezado esté presente
      return res.send({ space: result.rows[0].db_size_mb });
    } else {
      return res.status(500).send({
        err: true,
        message:
          "Hubo un error al consultar el espacio de la base de datos, por favor intente nuevamente",
      });
    }
  } catch (error) {
    console.error("Error executing query:", error);
    res.status(500).send("Internal Server Error");
  }
});

app.get("/get-all-clients", async (req, res) => {
  const query = "SELECT * FROM users";
  try {
    const response = await clientSupabase.query(query);
    if (response.rowCount > 0) {
      return res.status(200).send(response.rows);
    } else {
      return res.status(500).json({
        message: "Error al traer los clientes del servidor",
        error: response,
      });
    }
  } catch (error) {
    return res.status(500).json({
      message:
        "Error interno del servidor, no se pudo traer los clientes del servidor",
      error: error,
    });
  }
});

app.get("/get-debts-client", async (req, res) => {
  const { clientID } = req.query;
  const query1 = "SELECT * FROM debts WHERE uuid= $1";
  const query2 = 'SELECT * FROM "registerDelierys" WHERE uuid_cliente = $1';
  const query3 = "SELECT * FROM users WHERE uuid = $1";
  try {
    const response3 = await clientSupabase.query(query3, [clientID]);
    const response2 = await clientSupabase.query(query2, [clientID]);
    const response1 = await clientSupabase.query(query1, [clientID]);
    if ((response3.rows && response1.rows) || response2.rows) {
      return res.status(200).json({
        deudas: response1.rows,
        entregas: response2.rows,
        clientData: response3.rows,
      });
    } else {
      return res
        .status(400)
        .json({ message: "No se pudo traer las deudas del servidor" });
    }
  } catch (error) {
    console.log(error);
    return res.status(500).json({
      message:
        "Error interno del servidor: no se pudo traer las deudas del servidor",
    });
  }
});

app.post("/add-debts", async (req, res) => {
  const { clientID, clientName } = req.query;
  const { fecha, productos } = req.body;
  const dueDate = dayjs(fecha).add(1, "month").format("YYYY-MM-DD");
  const FormattedDate = dayjs(fecha).format("DD-MM-YYYY");
  try {
    await clientSupabase.query("BEGIN");

    for (const producto of productos) {
      const { cantidad, nombre_producto, precio, moneda } = producto;

      const insertQuery = `
        INSERT INTO debts (uuid, "buyDate", "nameProduct", quantity, price, change, duedate, nombre_cliente, estado)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'activo');
      `;
      const values = [
        clientID,
        FormattedDate,
        nombre_producto,
        cantidad || 1,
        precio,
        moneda,
        dueDate,
        clientName,
      ];
      const response = await clientSupabase.query(insertQuery, values);

      if (response.rowCount === 0) {
        throw new Error(`Error al insertar el producto: ${nombre_producto}`);
      }
    }

    await clientSupabase.query("COMMIT");
    res.status(200).send({ message: "Productos añadidos correctamente!" });
  } catch (error) {
    await clientSupabase.query("ROLLBACK");
    console.error("Error al insertar deudas:", error);
    res
      .status(500)
      .send({ message: "Error al insertar deudas, intente nuevamente." });
  }
});

app.post("/make-deliver", async (req, res) => {
  const { clientID, clientName } = req.query;
  const { fecha_entrega, monto } = req.body;
  const advanceOneMonth = dayjs(fecha_entrega).add(1, "month");

  const formattMonth = dayjs(fecha_entrega).format("DD-MM-YYYY");

  const query1 =
    'INSERT INTO "registerDelierys"(uuid_cliente, monto_entrega, fecha_entrega) VALUES($1,$2,$3)';
  const query2 =
    "UPDATE debts SET estado = 'activo', duedate = $1 WHERE uuid = $2";

  try {
    await clientSupabase.query("BEGIN");
    const response1 = await clientSupabase.query(query1, [
      clientID,
      monto,
      formattMonth,
    ]);
    const response2 = await clientSupabase.query(query2, [
      advanceOneMonth,
      clientID,
    ]);
    if (response1.rowCount > 0 || response2.rowCount > 0) {
      await clientSupabase.query("COMMIT");
      return res.status(200).json({ message: "Entrega añadida exitosamente" });
    } else {
      await clientSupabase.query("ROLLBACK");
      return res.status(400).json({
        message: "Hubo un problema al añadir la entrega, intente nuevamente",
      });
    }
  } catch (error) {
    await clientSupabase.query("ROLLBACK");
    console.error("Error al guardar la entrega:", error);
    res.status(500).send({
      message:
        "Error interno del servidor: Error al guardar la entrega, intente nuevamente.",
    });
  }
});

app.post("/cancel-debts", async (req, res) => {
  const { clientID, clientName, deudas, entregas } = req.body[0];
  const today = argTime.format("YYYY-MM-DD");
  // console.log(req.body[0])
  const query1 =
    'INSERT INTO "userHistory"("nombre_completo", "fecha_cancelacion", "detalle_deudas", "detalle_entregas", "userId") VALUES($1,$2,$3,$4,$5)';
  const query2 = "DELETE FROM debts WHERE uuid=$1";
  const query3 = 'DELETE FROM "registerDelierys" WHERE uuid_cliente = $1';

  try {
    await clientSupabase.query("BEGIN");
    const response1 = await clientSupabase.query(query1, [
      clientName,
      today,
      deudas,
      entregas,
      clientID,
    ]);
    const response2 = await clientSupabase.query(query2, [clientID]);
    const response3 = await clientSupabase.query(query3, [clientID]);

    if (
      response1.rowCount > 0 &&
      response2.rowCount > 0 &&
      response3.rowCount > 0
    ) {
      await clientSupabase.query("COMMIT");
      return res.status(200).send();
    } else {
      await clientSupabase.query("ROLLBACK");
      return res.status(400).json({
        message: "Hubo un error al cancelar las deudas, intente nuevamente.",
      });
    }
  } catch (error) {
    await clientSupabase.query("ROLLBACK");
    console.error("Error al cancelar las deudas:", error);
    res.status(500).send({
      message:
        "Error interno del servidor: Error al cancelar las deudas, intente nuevamente.",
    });
  }
});

app.get("/get-history", async (req, res) => {
  const { clientID } = req.query;
  const query = 'SELECT * FROM "userHistory" WHERE "userId" = $1';

  if (clientID) {
    try {
      const response = await clientSupabase.query(query, [clientID]);
      if (response.rows) {
        return res.status(200).send(response.rows);
      } else {
        return res
          .status(400)
          .json({ message: "No se encontraron registros de este cliente" });
      }
    } catch (error) {
      return res
        .status(500)
        .json({
          message:
            "Error interno del servidor: No se pudo traer el historial del cliente",
          error,
        });
    }
  } else {
    return res.status(400).json({ message: "El ID del cliente es requerido" });
  }
});

app.get("/get-view-vencimientos", async (req, res) => {
  const query = "SELECT * FROM vista_vencimientos";
  try {
    const response = await clientSupabase.query(query);
    if (response.rows) {
      return res.status(200).send(response.rows);
    } else {
      return res
        .status(400)
        .json({ message: "No hay vencimientos para mostrar" });
    }
  } catch (error) {
    return res
      .status(500)
      .json({
        message:
          "Error del servidor: No se pudieron traer los vencimientos, recargue la página para intentarlo nuevamente",
      });
  }
});

app.post("/create-clients", async (req, res) => {
  const { nombre_completo, apodo, dni, telefono } = req.body.values;

  const query1 =
    "SELECT COUNT(*) AS existe FROM users WHERE LOWER(nombre_completo) = $1";
  const query2 = "SELECT COUNT(*) AS existe FROM users WHERE dni = $1";
  const query3 =
    "INSERT INTO users(nombre_completo, dni, telefono, apodo) VALUES($1, $2, $3, $4)";

  try {
    const nombreExiste = await clientSupabase.query(query1, [
      nombre_completo.toLowerCase(),
    ]);
    if (nombreExiste.rows[0].existe > 0) {
      return res
        .status(400)
        .json({
          message: "El nombre completo ya existe, por favor intente con otro.",
        });
    }

    const dniExiste = await clientSupabase.query(query2, [dni]);
    if (dniExiste.rows[0].existe > 0) {
      return res
        .status(400)
        .json({
          message: "El DNI ya está registrado, por favor intente con otro.",
        });
    }

    const response = await clientSupabase.query(query3, [
      nombre_completo.toLowerCase(),
      dni,
      telefono,
      apodo,
    ]);

    if (response.rowCount > 0) {
      return res.status(200).send();
    } else {
      return res
        .status(400)
        .json({
          message: "No se pudo crear el cliente, por favor intente nuevamente.",
        });
    }
  } catch (error) {
    console.error("Error en la creación del cliente:", error);
    return res
      .status(500)
      .json({
        message:
          "Error interno del servidor: No se pudo crear el cliente, por favor intente nuevamente.",
      });
  }
});

app.delete("/delete-product", async (req, res) => {
  const idProduct = req.query.idProduct;
  const query = "DELETE FROM debts WHERE id = $1";

  try {
    await clientSupabase.query("BEGIN");

    const response = await clientSupabase.query(query, [idProduct]);

    if (response.rowCount === 1) {
      await clientSupabase.query("COMMIT");
      return res.status(200).json({ message: "Producto eliminado con éxito" });
    } else {
      await clientSupabase.query("ROLLBACK");
      return res
        .status(404)
        .json({ message: "Producto no encontrado o ya eliminado" });
    }
  } catch (error) {
    await clientSupabase.query("ROLLBACK");
    console.error("Error al eliminar el producto:", error);
    return res
      .status(500)
      .json({
        message: "Error interno del servidor: No se pudo eliminar el producto",
      });
  }
});

app.delete("/delete-deliver", async (req, res) => {
  const idDeliver = req.query.idDeliver;
  console.log(idDeliver);
  const query = 'DELETE FROM "registerDelierys" WHERE id = $1';

  try {
    await clientSupabase.query("BEGIN");

    const response = await clientSupabase.query(query, [idDeliver]);

    if (response.rowCount === 1) {
      await clientSupabase.query("COMMIT");
      return res.status(200).json({ message: "Entrega eliminada con éxito" });
    } else {
      await clientSupabase.query("ROLLBACK");
      return res
        .status(404)
        .json({ message: "Entrega no encontrado o ya eliminado" });
    }
  } catch (error) {
    await clientSupabase.query("ROLLBACK");
    console.error("Error al eliminar la Entrega:", error);
    return res
      .status(500)
      .json({
        message: "Error interno del servidor: No se pudo eliminar la Entrega",
      });
  }
});

app.listen(process.env.PORT || 4000, () => {
  console.log("Servidor levantado en el puerto 4000");
});

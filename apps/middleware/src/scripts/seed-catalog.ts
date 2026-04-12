import { config } from "../config.js";
import { createDatabase } from "../db/database.js";
import { PartDbOutbox } from "../outbox/partdb-outbox.js";
import { PartDbOutboxWorker } from "../outbox/partdb-worker.js";
import { PartDbClient } from "../partdb/partdb-client.js";
import { CategoryResolver } from "../partdb/category-resolver.js";
import { PartDbOperations } from "../partdb/partdb-operations.js";
import { PartDbRestClient } from "../partdb/partdb-rest.js";
import { PartDbCategoriesResource } from "../partdb/resources/categories.js";
import { PartDbMeasurementUnitsResource } from "../partdb/resources/measurement-units.js";
import { PartDbPartLotsResource } from "../partdb/resources/part-lots.js";
import { PartDbPartsResource } from "../partdb/resources/parts.js";
import { PartDbStorageLocationsResource } from "../partdb/resources/storage-locations.js";
import { InventoryService } from "../services/inventory-service.js";
import { defaultMeasurementUnit, type NewPartTypeDraft } from "@smart-db/contracts";

interface SeedItem {
  sku: string;        // Robu.in SKU
  name: string;       // Canonical name
  category: string;   // Slash-separated path
  countable: boolean; // true → instances, false → bulk
  unit?: { symbol: string; name: string; isInteger: boolean };
}

const PCS = { symbol: "pcs", name: "Pieces", isInteger: true };

const CATALOG: SeedItem[] = [
  // ── Compute / Single Board Computers ────────────────────────
  { sku: "R257508", name: "Arduino UNO Q (ABX00162, 2GB)", category: "Compute/Single Board Computers", countable: true, unit: PCS },
  { sku: "1749032", name: "Raspberry Pi 5 Model 4GB", category: "Compute/Single Board Computers", countable: true, unit: PCS },
  { sku: "1749034", name: "Raspberry Pi 5 Model 8GB", category: "Compute/Single Board Computers", countable: true, unit: PCS },
  { sku: "R190344", name: "Raspberry Pi Pico 2 W", category: "Compute/Single Board Computers", countable: true, unit: PCS },
  { sku: "R150220", name: "Raspberry Pi Pico 2", category: "Compute/Single Board Computers", countable: true, unit: PCS },
  { sku: "1012200", name: "Adafruit Feather nRF52840 Sense", category: "Compute/Single Board Computers", countable: true, unit: PCS },

  // ── Compute / Development Boards ────────────────────────────
  { sku: "1470148", name: "STM32 Nucleo-F030R8 Development Board", category: "Compute/Development Boards", countable: true, unit: PCS },
  { sku: "1470139", name: "STM32 Nucleo F303ZE Development Board", category: "Compute/Development Boards", countable: true, unit: PCS },
  { sku: "1382834", name: "STM32 Nucleo-F042K6 Development Board", category: "Compute/Development Boards", countable: true, unit: PCS },

  // ── Motors / Servo Motors ───────────────────────────────────
  { sku: "1308083", name: "TowerPro MG90S Mini Digital Servo (180°)", category: "Motors/Servo Motors", countable: true, unit: PCS },
  { sku: "R251563", name: "Pro-Range DS3218 20kg.cm Metal Gear Digital Servo (180°)", category: "Motors/Servo Motors", countable: true, unit: PCS },
  { sku: "43579",   name: "TowerPro MG995 Metal Gear Servo (180°)", category: "Motors/Servo Motors", countable: true, unit: PCS },
  { sku: "1331215", name: "Waveshare 30KG Serial Bus Servo", category: "Motors/Servo Motors", countable: true, unit: PCS },
  { sku: "1738071", name: "Waveshare 20kg.cm Bus Servo (106 RPM)", category: "Motors/Servo Motors", countable: true, unit: PCS },

  // ── Motors / DC Geared Motors ───────────────────────────────
  { sku: "104024",  name: "BO Motor 300 RPM Dual Shaft Straight", category: "Motors/DC Geared Motors", countable: true, unit: PCS },
  { sku: "25339",   name: "BO Motor 60 RPM Straight", category: "Motors/DC Geared Motors", countable: true, unit: PCS },
  { sku: "51872",   name: "N20 12V 600 RPM Micro Metal Gear Motor", category: "Motors/DC Geared Motors", countable: true, unit: PCS },
  { sku: "475525",  name: "N20 12V 120 RPM Micro Metal Gear Motor with Encoder", category: "Motors/DC Geared Motors", countable: true, unit: PCS },
  { sku: "476598",  name: "N20 6V 70 RPM Micro Metal Gear Motor with Encoder", category: "Motors/DC Geared Motors", countable: true, unit: PCS },
  { sku: "1770457", name: "JGB37-555 12V 500 RPM DC Reduction Motor", category: "Motors/DC Geared Motors", countable: true, unit: PCS },
  { sku: "1770449", name: "JGB37-520 12V 320 RPM DC Reduction Motor", category: "Motors/DC Geared Motors", countable: true, unit: PCS },
  { sku: "1557392", name: "RS775SH 12V 6000 RPM DC Motor (6mm shaft)", category: "Motors/DC Geared Motors", countable: true, unit: PCS },
  { sku: "812266",  name: "Pro-Range PGM45775 12V 50 RPM Planetary Gear Motor (392 N·cm)", category: "Motors/DC Geared Motors", countable: true, unit: PCS },
  { sku: "2103",    name: "Johnson Geared Motor 1000 RPM (Grade B)", category: "Motors/DC Geared Motors", countable: true, unit: PCS },

  // ── Motors / Brushless Motors ───────────────────────────────
  { sku: "R101295", name: "Tarot TL96020 5008 340KV Brushless Motor", category: "Motors/Brushless Motors", countable: true, unit: PCS },
  { sku: "1086410", name: "SunFun D2207 2450KV BLDC Motor", category: "Motors/Brushless Motors", countable: true, unit: PCS },
  { sku: "R110922", name: "T-Motor 2207 v2 1750KV Brushless Motor", category: "Motors/Brushless Motors", countable: true, unit: PCS },
  { sku: "1504803", name: "Eaglepower LA8308 KV90 Brushless Motor", category: "Motors/Brushless Motors", countable: true, unit: PCS },
  { sku: "1272309", name: "T-Motor Antigravity MN5008 KV340 Brushless Motor", category: "Motors/Brushless Motors", countable: true, unit: PCS },

  // ── Motors / Stepper Motors ─────────────────────────────────
  { sku: "51732",   name: "JK42HS40-1204AF-02 NEMA17 4.2 kg-cm Stepper Motor", category: "Motors/Stepper Motors", countable: true, unit: PCS },

  // ── Motors / Vibration Motors ───────────────────────────────
  { sku: "30624",   name: "Flat 1034 Mobile Phone Vibrator Motor", category: "Motors/Vibration Motors", countable: true, unit: PCS },
  { sku: "1358105", name: "Encapsulated Vibration Motor 8000±2000 RPM", category: "Motors/Vibration Motors", countable: true, unit: PCS },

  // ── Motor Control / Stepper Drivers ─────────────────────────
  { sku: "1555084", name: "TMC2209 v3.0 Stepper Driver Module", category: "Motor Control/Stepper Drivers", countable: true, unit: PCS },
  { sku: "6721",    name: "DRV8825 Stepper Driver with Heat Sink", category: "Motor Control/Stepper Drivers", countable: true, unit: PCS },

  // ── Motor Control / DC Motor Drivers ────────────────────────
  { sku: "5828",    name: "L298N Motor Driver Module 2A", category: "Motor Control/DC Motor Drivers", countable: true, unit: PCS },
  { sku: "43846",   name: "TB6612FNG Motor Driver Module", category: "Motor Control/DC Motor Drivers", countable: true, unit: PCS },
  { sku: "456144",  name: "Double BTS7960 43A H-Bridge Motor Driver", category: "Motor Control/DC Motor Drivers", countable: true, unit: PCS },

  // ── Motor Control / PWM and Servo Drivers ───────────────────
  { sku: "43740",   name: "PCA9685 16-Channel 12-bit PWM/Servo Driver (I2C)", category: "Motor Control/PWM and Servo Drivers", countable: true, unit: PCS },
  { sku: "1782919", name: "Waveshare Serial Bus Servo Driver Board", category: "Motor Control/PWM and Servo Drivers", countable: true, unit: PCS },

  // ── Motor Control / ESCs ────────────────────────────────────
  { sku: "1395359", name: "40A 2-6S ESC (3.5mm Banana)", category: "Motor Control/ESCs", countable: true, unit: PCS },
  { sku: "1374858", name: "T-Motor Alpha 80A 12S ESC", category: "Motor Control/ESCs", countable: true, unit: PCS },

  // ── Sensors / Environmental ─────────────────────────────────
  { sku: "181464",  name: "DHT22 / AM2302 Digital Temperature & Humidity Sensor", category: "Sensors/Environmental", countable: true, unit: PCS },
  { sku: "835814",  name: "GY-BMP280-5V Temperature Sensor Module", category: "Sensors/Environmental", countable: true, unit: PCS },
  { sku: "415967",  name: "BMP280 Barometric Pressure & Altitude Sensor (I2C/SPI)", category: "Sensors/Environmental", countable: true, unit: PCS },

  // ── Sensors / IMU ───────────────────────────────────────────
  { sku: "R243089", name: "601N1-ICM45686 6-axis IMU Module", category: "Sensors/Inertial", countable: true, unit: PCS },

  // ── Sensors / Encoders ──────────────────────────────────────
  { sku: "7876",    name: "Pro-Range 400 PPR 2-Phase Optical Rotary Encoder", category: "Sensors/Encoders", countable: true, unit: PCS },
  { sku: "301983",  name: "OE-37 Hall Effect Two-Channel Magnetic Encoder", category: "Sensors/Encoders", countable: true, unit: PCS },

  // ── Power / LiPo Batteries ──────────────────────────────────
  { sku: "70120",   name: "Pro-Range 3.7V 1000mAh 30C 1S LiPo Battery", category: "Power/LiPo Batteries", countable: true, unit: PCS },
  { sku: "R261189", name: "Pro-Range 22.2V 16000mAh 25C 6S LiPo Battery (XT-90)", category: "Power/LiPo Batteries", countable: true, unit: PCS },
  { sku: "1125107", name: "Pro-Range 3.7V 5200mAh 25C 1S LiPo Battery", category: "Power/LiPo Batteries", countable: true, unit: PCS },

  // ── Power / Li-Ion Batteries ────────────────────────────────
  { sku: "R149976", name: "Pro-Range INR 21700-P45B 22.2V 4500mAh 6S1P Li-Ion Pack", category: "Power/Li-Ion Batteries", countable: true, unit: PCS },

  // ── Cameras / Raspberry Pi Cameras ──────────────────────────
  { sku: "1323466", name: "Waveshare RPi IR-CUT Camera (B)", category: "Cameras/Raspberry Pi Cameras", countable: true, unit: PCS },
  { sku: "1323462", name: "Waveshare RPi Camera (I, Fisheye)", category: "Cameras/Raspberry Pi Cameras", countable: true, unit: PCS },

  // ── Cameras / USB Cameras ───────────────────────────────────
  { sku: "1718466", name: "Arducam 12MP USB Camera Module (M12 lens, 4K)", category: "Cameras/USB Cameras", countable: true, unit: PCS },

  // ── Actuators / Linear Actuators ────────────────────────────
  { sku: "890198",  name: "12V 150mm Stroke Linear Actuator (6000N, 5mm/s)", category: "Actuators/Linear Actuators", countable: true, unit: PCS },

  // ── Actuators / Solenoids ───────────────────────────────────
  { sku: "312517",  name: "1240 12V DC 0.6A 7.5W Solenoid Door Lock", category: "Actuators/Solenoids", countable: true, unit: PCS },
  { sku: "130279",  name: "DC 12V KK-P25/20 8KG Lifting Solenoid Electromagnet", category: "Actuators/Solenoids", countable: true, unit: PCS },
  { sku: "130278",  name: "DC 12V KK-P20/15 3KG Lifting Solenoid Electromagnet", category: "Actuators/Solenoids", countable: true, unit: PCS },

  // ── Actuators / Pumps ───────────────────────────────────────
  { sku: "301183",  name: "DC 3-6V Mini Submersible Water Pump", category: "Actuators/Pumps", countable: true, unit: PCS },
  { sku: "31125",   name: "DC 6-12V Aquarium Water Pump R385", category: "Actuators/Pumps", countable: true, unit: PCS },

  // ── Mechanical / Servo Accessories ──────────────────────────
  { sku: "28414",   name: "CNC Aluminum Steering Servo Horn (Futaba 25T)", category: "Mechanical/Servo Accessories", countable: true, unit: PCS },
];

async function main(): Promise<void> {
  const db = createDatabase(config.dataPath);
  const syncEnabled =
    config.partDb.syncEnabled &&
    Boolean(config.partDb.baseUrl) &&
    Boolean(config.partDb.apiToken);
  const outbox = syncEnabled ? new PartDbOutbox(db) : null;
  const service = new InventoryService(db, new PartDbClient(config.partDb), outbox);

  let created = 0;
  let skipped = 0;

  for (const item of CATALOG) {
    const draft: NewPartTypeDraft = {
      kind: "new",
      canonicalName: item.name,
      category: item.category,
      aliases: [item.sku],
      notes: `Robu.in SKU ${item.sku}`,
      imageUrl: null,
      countable: item.countable,
      unit: item.unit ?? defaultMeasurementUnit,
    };

    try {
      // Use private resolvePartType + ensurePartTypeSync via casting.
      // This creates the part type catalog entry without an inventory entity.
      const correlationId = (globalThis.crypto ?? require("node:crypto") as { randomUUID: () => string }).randomUUID();
      const partType = (service as unknown as {
        resolvePartType: (d: NewPartTypeDraft) => { id: string; canonicalName: string };
      }).resolvePartType(draft);
      (service as unknown as {
        ensurePartTypeSync: (pt: unknown, c: string) => string | null;
      }).ensurePartTypeSync(partType, correlationId);
      console.log(`✓ ${item.sku}  ${item.name}  →  ${item.category}`);
      created += 1;
    } catch (error) {
      console.error(`✗ ${item.sku}  ${item.name}`, (error as Error).message);
      skipped += 1;
    }
  }

  console.log(`\nSeed complete. Created ${created}, skipped ${skipped}.`);

  if (!syncEnabled || !outbox) {
    console.log("Part-DB sync disabled; nothing more to drain.");
    db.close?.();
    return;
  }

  // Drain the outbox synchronously by ticking the worker repeatedly.
  const rest = new PartDbRestClient({
    baseUrl: config.partDb.baseUrl!,
    apiToken: config.partDb.apiToken!,
  });
  const worker = new PartDbOutboxWorker(
    outbox,
    new PartDbOperations(
      new CategoryResolver(db, new PartDbCategoriesResource(rest)),
      new PartDbMeasurementUnitsResource(rest),
      new PartDbPartsResource(rest),
      new PartDbPartLotsResource(rest),
      new PartDbStorageLocationsResource(rest),
    ),
    console,
    { intervalMs: 0 },
  );

  let totalDelivered = 0;
  let totalFailed = 0;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const tick = await worker.tick();
    totalDelivered += tick.delivered;
    totalFailed += tick.failed;
    if (tick.claimed === 0) break;
  }
  console.log(`Part-DB sync drained: delivered ${totalDelivered}, failed ${totalFailed}.`);

  db.close?.();
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

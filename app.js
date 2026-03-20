const STORAGE_KEY = "novus_ultra_data";
const BIN_KEY = "novus_ultra_active_bin";
const FIELD_PROFILES = [
    {
        key: "hu",
        label: "HU",
        fieldId: "resHU",
        cardId: "cardHU",
        expectedLength: 10,
        minDigits: 8,
        maxDigits: 12,
        ocrZones: [
            { xStart: 0.02, xEnd: 0.46, yStart: 0.13, yEnd: 0.27, invert: true, threshold: 140 },
            { xStart: 0.00, xEnd: 0.50, yStart: 0.10, yEnd: 0.29, invert: true, threshold: 145 }
        ],
        barcodeZones: [
            { xStart: 0.40, xEnd: 0.98, yStart: 0.11, yEnd: 0.27 },
            { xStart: 0.30, xEnd: 0.99, yStart: 0.09, yEnd: 0.30 }
        ]
    },
    {
        key: "mat",
        label: "Material",
        fieldId: "resMat",
        cardId: "cardMat",
        expectedLength: 7,
        minDigits: 5,
        maxDigits: 9,
        ocrZones: [
            { xStart: 0.03, xEnd: 0.49, yStart: 0.44, yEnd: 0.57, invert: true, threshold: 140 },
            { xStart: 0.00, xEnd: 0.54, yStart: 0.41, yEnd: 0.60, invert: true, threshold: 145 }
        ],
        barcodeZones: [
            { xStart: 0.46, xEnd: 0.95, yStart: 0.43, yEnd: 0.58 },
            { xStart: 0.32, xEnd: 0.98, yStart: 0.40, yEnd: 0.61 }
        ]
    },
    {
        key: "bat",
        label: "Batch",
        fieldId: "resBat",
        cardId: "cardBat",
        expectedLength: 5,
        minDigits: 4,
        maxDigits: 6,
        ocrZones: [
            { xStart: 0.12, xEnd: 0.42, yStart: 0.73, yEnd: 0.84, invert: false, threshold: 180 },
            { xStart: 0.08, xEnd: 0.46, yStart: 0.70, yEnd: 0.86, invert: false, threshold: 185 }
        ],
        barcodeZones: [
            { xStart: 0.48, xEnd: 0.90, yStart: 0.76, yEnd: 0.90 },
            { xStart: 0.34, xEnd: 0.94, yStart: 0.72, yEnd: 0.92 }
        ]
    }
];

let currentBin = "";
let scans = loadScans();
let ocrWorkerPromise = null;
const multiReader = new ZXing.BrowserMultiFormatReader();

function loadScans() {
    try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    } catch (error) {
        console.error("Failed to load saved scans", error);
        return [];
    }
}

function persistScans() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(scans));
}

function setStatus(message, tone) {
    const banner = document.getElementById("scanStatus");
    banner.textContent = message || "";
    banner.className = "status-banner" + (tone ? " " + tone : "");
}

function beep() {
    try {
        const AudioCtor = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtor) {
            return;
        }

        const ctx = new AudioCtor();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = "square";
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.1, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.1);
        osc.start();
        osc.stop(ctx.currentTime + 0.1);
        osc.onended = () => ctx.close();
    } catch (error) {
        console.warn("Beep unavailable", error);
    }
}

function initScanner() {
    const bin = document.getElementById("binInput").value.trim().toUpperCase();
    if (!bin) {
        alert("Enter Bin Location");
        return;
    }

    currentBin = bin;
    localStorage.setItem(BIN_KEY, currentBin);
    document.getElementById("activeBin").textContent = bin;
    showScanner();
    setStatus("Scanner ready for bin " + currentBin + ".", "success");
}

function showScreen(screenId) {
    document.querySelectorAll(".screen").forEach((screen) => screen.classList.add("hidden"));
    document.getElementById(screenId).classList.remove("hidden");
}

function showScanner() {
    showScreen("sScanner");
}

function showLog() {
    showScreen("sLog");
    renderLog();
}

function applyFieldValue(fieldId, cardId, value) {
    const field = document.getElementById(fieldId);
    const card = document.getElementById(cardId);
    field.value = value || "";
    card.classList.toggle("found", Boolean(value));
}

function normalizeDigits(text) {
    return String(text || "")
        .toUpperCase()
        .replace(/[OQD]/g, "0")
        .replace(/[IL|]/g, "1")
        .replace(/S/g, "5")
        .replace(/B/g, "8")
        .replace(/Z/g, "2")
        .replace(/G/g, "6")
        .replace(/\D/g, "");
}

function buildCandidate(value, profile, source) {
    if (!value) {
        return null;
    }

    if (value.length < profile.minDigits || value.length > profile.maxDigits) {
        return null;
    }

    const diff = Math.abs(value.length - profile.expectedLength);
    return {
        value,
        source,
        score: (value.length === profile.expectedLength ? 40 : 0) + Math.max(0, 20 - (diff * 6)) + (source === "ocr" ? 10 : 0)
    };
}

function pickBestCandidate(candidates) {
    const deduped = new Map();

    candidates.forEach((candidate) => {
        if (!candidate) {
            return;
        }

        const existing = deduped.get(candidate.value);
        if (!existing || candidate.score > existing.score) {
            deduped.set(candidate.value, candidate);
        }
    });

    return [...deduped.values()]
        .sort((a, b) => b.score - a.score || b.value.length - a.value.length)[0]?.value || "";
}

function applyDetectedValues(values) {
    const foundLabels = [];

    FIELD_PROFILES.forEach((profile) => {
        const value = values[profile.key] || "";
        applyFieldValue(profile.fieldId, profile.cardId, value);
        if (value) {
            foundLabels.push(profile.label);
        }
    });

    if (!foundLabels.length) {
        setStatus("No values were extracted. Manual entry is still available.", "error");
        return false;
    }

    setStatus("Captured " + foundLabels.join(", ") + ".", "success");
    return true;
}

async function getOcrWorker() {
    if (!window.Tesseract) {
        return null;
    }

    if (!ocrWorkerPromise) {
        ocrWorkerPromise = Tesseract.createWorker("eng");
    }

    return ocrWorkerPromise;
}

async function scanSelectedImage(file) {
    const imgUrl = URL.createObjectURL(file);

    try {
        const img = await loadImage(imgUrl);
        const values = await detectFieldValues(img);

        if (applyDetectedValues(values)) {
            beep();
            if (navigator.vibrate) {
                navigator.vibrate(200);
            }
            return;
        }

        alert("Could not read the HU, Material, or Batch values. Try a flatter photo with the black number boxes fully visible.");
    } finally {
        URL.revokeObjectURL(imgUrl);
    }
}

async function detectFieldValues(img) {
    const values = { hu: "", mat: "", bat: "" };

    for (const profile of FIELD_PROFILES) {
        values[profile.key] = await detectFieldValue(img, profile);
    }

    return values;
}

async function detectFieldValue(img, profile) {
    const candidates = [];
    const worker = await getOcrWorker().catch((error) => {
        console.warn("OCR worker unavailable", error);
        ocrWorkerPromise = null;
        return null;
    });

    if (worker) {
        for (const zone of profile.ocrZones) {
            try {
                setStatus("Reading " + profile.label + "...", "");
                const text = await recognizeDigitsFromZone(worker, img, zone);
                candidates.push(buildCandidate(normalizeDigits(text), profile, "ocr"));
            } catch (error) {
                console.warn("OCR failed for " + profile.label, error);
            }
        }
    }

    for (const zone of profile.barcodeZones) {
        try {
            const decoded = await decodeBarcodeFromZone(img, zone);
            candidates.push(buildCandidate(normalizeDigits(decoded), profile, "barcode"));
        } catch (error) {
            console.warn("Barcode fallback failed for " + profile.label, error);
        }
    }

    return pickBestCandidate(candidates);
}

async function recognizeDigitsFromZone(worker, img, zone) {
    const processedCanvas = createRegionCanvas(img, zone, {
        scale: 3,
        threshold: zone.threshold,
        invert: zone.invert,
        binarize: true
    });

    const result = await worker.recognize(processedCanvas.toDataURL("image/png"));
    return result && result.data ? result.data.text : "";
}

async function decodeBarcodeFromZone(img, zone) {
    const regionCanvas = createRegionCanvas(img, zone, { scale: 2, binarize: false });
    const croppedImage = await loadImage(regionCanvas.toDataURL("image/png"));
    const result = await multiReader.decodeFromImageElement(croppedImage);
    return result && result.text ? result.text : "";
}

function createRegionCanvas(img, zone, options) {
    const settings = options || {};
    const scale = settings.scale || 1;
    const rect = getRegionRect(img, zone);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");

    canvas.width = Math.max(1, Math.round(rect.width * scale));
    canvas.height = Math.max(1, Math.round(rect.height * scale));

    if (!context) {
        return canvas;
    }

    context.imageSmoothingEnabled = !settings.binarize;
    context.filter = "grayscale(1) contrast(180%) brightness(108%)";
    context.drawImage(
        img,
        rect.x,
        rect.y,
        rect.width,
        rect.height,
        0,
        0,
        canvas.width,
        canvas.height
    );
    context.filter = "none";

    if (settings.binarize) {
        const threshold = typeof settings.threshold === "number" ? settings.threshold : 160;
        const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;

        for (let index = 0; index < data.length; index += 4) {
            const grayscale = (data[index] * 0.299) + (data[index + 1] * 0.587) + (data[index + 2] * 0.114);
            let value = grayscale > threshold ? 255 : 0;

            if (settings.invert) {
                value = 255 - value;
            }

            data[index] = value;
            data[index + 1] = value;
            data[index + 2] = value;
        }

        context.putImageData(imageData, 0, 0);
    }

    return canvas;
}

function getRegionRect(img, zone) {
    const x = Math.max(0, Math.floor(img.width * zone.xStart));
    const y = Math.max(0, Math.floor(img.height * zone.yStart));
    const width = Math.max(1, Math.floor(img.width * (zone.xEnd - zone.xStart)));
    const height = Math.max(1, Math.floor(img.height * (zone.yEnd - zone.yStart)));

    return { x, y, width, height };
}

function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
    });
}

document.getElementById("cameraInput").addEventListener("change", async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) {
        return;
    }

    document.getElementById("overlay").classList.remove("hidden");
    setStatus("Reading label...", "");

    try {
        await scanSelectedImage(file);
    } catch (error) {
        console.error(error);
        setStatus("Scanning failed. You can still enter values manually.", "error");
        alert("Scanning failed. You can enter values manually.");
    } finally {
        document.getElementById("overlay").classList.add("hidden");
        document.getElementById("cameraInput").value = "";
    }
});

function saveData() {
    if (!currentBin) {
        alert("Set a bin location before saving.");
        showScreen("sSetup");
        return;
    }

    const data = {
        bin: currentBin,
        hu: document.getElementById("resHU").value.trim() || "N/A",
        mat: document.getElementById("resMat").value.trim() || "N/A",
        bat: document.getElementById("resBat").value.trim() || "N/A",
        time: new Date().toLocaleString()
    };

    scans.unshift(data);
    persistScans();
    resetScanner();
    setStatus("Entry saved locally.", "success");
    alert("Entry Saved to Local Storage");
}

function resetScanner() {
    applyFieldValue("resHU", "cardHU", "");
    applyFieldValue("resMat", "cardMat", "");
    applyFieldValue("resBat", "cardBat", "");
    setStatus("", "");
    document.getElementById("cameraInput").value = "";
}

function renderLog() {
    const list = document.getElementById("logList");

    if (!scans.length) {
        list.innerHTML = "<div class=\"empty-log\">No saved scans yet.</div>";
        return;
    }

    list.innerHTML = scans.map((scan) => `
        <div class="log-item">
            <div style="display: flex; justify-content: space-between; gap: 12px; margin-bottom: 5px;">
                <span style="color: var(--accent); font-weight: 800;">BIN: ${escapeHtml(scan.bin)}</span>
                <span style="opacity: 0.5;">${escapeHtml(scan.time)}</span>
            </div>
            HU: ${escapeHtml(scan.hu)}<br>
            MAT: ${escapeHtml(scan.mat)}<br>
            BAT: ${escapeHtml(scan.bat)}
        </div>
    `).join("");
}

function csvField(value) {
    const safeValue = String(value ?? "");
    return "\"" + safeValue.replace(/"/g, "\"\"") + "\"";
}

function exportCSV() {
    if (!scans.length) {
        alert("No scans available to export.");
        return;
    }

    let csv = "Bin,HU,Material,Batch,Timestamp\n";
    scans.forEach((scan) => {
        csv += [
            csvField(scan.bin),
            csvField(scan.hu),
            csvField(scan.mat),
            csvField(scan.bat),
            csvField(scan.time)
        ].join(",") + "\n";
    });

    const blob = new Blob([csv], { type: "text/csv" });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = "Novus_Export_" + Date.now() + ".csv";
    link.click();

    window.URL.revokeObjectURL(url);
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

(function restoreSession() {
    currentBin = localStorage.getItem(BIN_KEY) || "";
    if (currentBin) {
        document.getElementById("binInput").value = currentBin;
        document.getElementById("activeBin").textContent = currentBin;
        showScanner();
        setStatus("Restored previous bin session.", "success");
    } else {
        showScreen("sSetup");
    }
}());

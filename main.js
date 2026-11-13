// Funktion zum Extrahieren der JSON-Daten aus einer Pocket-Platformer-HTML-Datei
async function extractGameData(file) {
    const text = await file.text();
    const startComment = "//allDataStart";
    const endComment = "//allDataStart"; // Im Original wird zweimal derselbe Kommentar als Begrenzung genutzt

    const startIndex = text.indexOf(startComment);
    if (startIndex === -1) throw new Error("Keine gültige PocketPlatformer-Datei!");

    // Den JSON-Teil ausschneiden
    let jsonString = text.substring(startIndex + startComment.length, text.lastIndexOf(endComment));
    jsonString = jsonString.replace("const allData = ", "").trim();

    return JSON.parse(jsonString);
}

// Der eigentliche Merge-Prozess
async function mergeGames(file1, file2) {
    const data1 = await extractGameData(file1);
    const data2 = await extractGameData(file2);

    // 1. Level zusammenführen (Level von Spiel 2 an Spiel 1 anhängen)
    const mergedLevels = [...data1.levels, ...data2.levels];

    // Level-Indizes/Nummern fortlaufend anpassen
    mergedLevels.forEach((level, index) => {
        level.levelNumber = index + 1;
    });


    // 👉 HIER DAS LOG EINFÜGEN:
    console.log("GESAMTE LEVEL ANZAHL:", mergedLevels.length);
    console.log("ALLE LEVEL DATEN:", mergedLevels);

    // 2. Neues kombiniertes Datenobjekt erstellen (nutzt die Basis von Spiel 1)
    const mergedData = {
        ...data1,
        levels: mergedLevels,
        gamesName: (data1.gamesName || "Game") + " + " + (data2.gamesName || "Game2")
    };

    // Optional: Hier könnten später noch Sprites/Sounds gemerged werden

    return mergedData;
}

// Baut das neue HTML-Spiel zusammen, indem es Spiel 1 als Vorlage nutzt
function buildMergedHtml(originalHtmlText, mergedData) {
    const startComment = "//allDataStart";
    const endComment = "//allDataStart";

    const startIndex = originalHtmlText.indexOf(startComment);
    const endIndex = originalHtmlText.lastIndexOf(endComment);

    if (startIndex === -1 || endIndex === -1 || startIndex === endIndex) {
        throw new Error("Konnte den Datenblock im Template nicht ersetzen.");
    }

    const beforeData = originalHtmlText.substring(0, startIndex + startComment.length);
    const afterData = originalHtmlText.substring(endIndex);

    const newDataString = `\n  const allData = ${JSON.stringify(mergedData)}\n  `;
    return beforeData + newDataString + afterData;
}

// Löst den Download der fertigen HTML-Datei im Browser aus
function downloadHtmlFile(filename, htmlContent) {
    const blob = new Blob([htmlContent], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = `${filename}.html`;
    document.body.appendChild(a);
    a.click();

    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// Event-Listener für den Button in der index.html
document.getElementById("mergeButton").addEventListener("click", async () => {
    const fileInput1 = document.getElementById("file1").files[0];
    const fileInput2 = document.getElementById("file2").files[0];
    const statusDiv = document.getElementById("status");

    if (!fileInput1 || !fileInput2) {
        statusDiv.innerText = "Bitte wähle beide Spiel-Dateien aus!";
        return;
    }

    try {
        statusDiv.innerText = "Spiele werden zusammengefügt...";

        // 1. Spiele datenmäßig mergen
        const mergedData = await mergeGames(fileInput1, fileInput2);

        // 2. Originaltext von Spiel 1 als HTML-Gerüst holen
        const templateHtml = await fileInput1.text();

        // 3. Neues HTML mit den gemergten Daten bauen
        const finalHtml = buildMergedHtml(templateHtml, mergedData);

        // 4. Download starten
        const safeFileName = (mergedData.gamesName || "Merged_Game").replace(/[^a-z0-9_-]/gi, '_');
        downloadHtmlFile(safeFileName, finalHtml);

        statusDiv.innerText = "Erfolgreich! Die Datei wurde heruntergeladen (" + mergedData.levels.length + " Level).";

    } catch (error) {
        console.error(error);
        statusDiv.innerText = "Fehler beim Mergen: " + error.message;
    }
});

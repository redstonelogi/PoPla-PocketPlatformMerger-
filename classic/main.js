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

function mergeSprites(games) {
    const mergedSprites = { ...(games[0].sprites || {}) };

    games.slice(1).forEach((game, gameOffset) => {
        const gameNumber = gameOffset + 2;
        const spriteKeyMap = new Map();
        const aliasedSprites = [];

        Object.entries(game.sprites || {}).forEach(([key, sprite]) => {
            const existing = mergedSprites[key];
            if (!existing) {
                mergedSprites[key] = sprite;
                spriteKeyMap.set(key, key);
                return;
            }

            if (JSON.stringify(existing) === JSON.stringify(sprite)) {
                spriteKeyMap.set(key, key);
                return;
            }

            if (!sprite.custom && !["objects", "tiles", "deco"].includes(sprite.type)) {
                spriteKeyMap.set(key, key);
                return;
            }

            const baseName = `${sprite.descriptiveName || sprite.name} (Game ${gameNumber})`;
            let descriptiveName = baseName;
            let suffix = 2;
            let aliasKey = descriptiveName.replace(/\s/g, "");
            while (mergedSprites[aliasKey] ||
                Object.values(mergedSprites).some(existingSprite => existingSprite.descriptiveName === descriptiveName)) {
                descriptiveName = `${baseName} ${suffix++}`;
                aliasKey = descriptiveName.replace(/\s/g, "");
            }

            const spriteCopy = { ...sprite, descriptiveName, custom: true };
            if (sprite.type === "tiles" && Number.isInteger(sprite.name)) {
                const tileNames = Object.values(mergedSprites)
                    .filter(existingSprite => existingSprite.type === "tiles")
                    .map(existingSprite => existingSprite.name)
                    .filter(Number.isInteger);
                spriteCopy.name = Math.max(17, ...tileNames) + 1;
            }

            mergedSprites[aliasKey] = spriteCopy;
            spriteKeyMap.set(key, aliasKey);
            aliasedSprites.push({ sprite, spriteCopy });
        });

        game.levels.forEach(level => {
            if (Array.isArray(level.tileData)) {
                Object.entries(game.sprites || {}).forEach(([key, sprite]) => {
                    const aliasKey = spriteKeyMap.get(key);
                    const aliasedSprite = aliasKey && mergedSprites[aliasKey];
                    if (aliasedSprite && aliasKey !== key &&
                        sprite.type === "tiles" && Number.isInteger(sprite.name)) {
                        level.tileData.forEach(row => {
                            row.forEach((value, index) => {
                                if (value === sprite.name) row[index] = aliasedSprite.name;
                            });
                        });
                    }
                });
            }

            ["levelObjects", "enemies", "weapons"].forEach(collectionName => {
                (level[collectionName] || []).forEach(object => {
                    aliasedSprites.forEach(({ sprite, spriteCopy }) => {
                        if (object.extraAttributes?.customName === sprite.descriptiveName ||
                            (sprite.type !== "deco" &&
                                (sprite.type === "objects" ||
                                    (sprite.type === "tiles" && !Number.isInteger(sprite.name))) &&
                                object.type === sprite.name && !object.extraAttributes?.customName)) {
                            object.extraAttributes = {
                                ...(object.extraAttributes || {}),
                                customName: spriteCopy.descriptiveName
                            };
                        }
                    });
                });
            });

            if (Array.isArray(level.deko)) {
                const sourceDeko = Object.entries(game.sprites || {})
                    .filter(([, sprite]) => sprite.name === "deco");
                const mergedDeko = Object.entries(mergedSprites)
                    .filter(([, sprite]) => sprite.name === "deco");
                level.deko.forEach(deko => {
                    const sourceKey = sourceDeko[deko.index]?.[0];
                    const destinationKey = sourceKey && spriteKeyMap.get(sourceKey);
                    const destinationIndex = mergedDeko.findIndex(([key]) => key === destinationKey);
                    if (destinationIndex !== -1) deko.index = destinationIndex;
                });
            }
        });
    });

    return mergedSprites;
}

// Der eigentliche Merge-Prozess
async function mergeGames(files) {
    if (files.length < 2) {
        throw new Error("Bitte wähle mindestens zwei Spiel-Dateien aus.");
    }

    const games = await Promise.all(files.map(extractGameData));
    games.forEach((game, index) => {
        if (!Array.isArray(game.levels) || game.levels.length < 2) {
            throw new Error(`Spiel ${index + 1} enthält keine gültigen Start- und Endbildschirm-Level.`);
        }
    });

    const mergedSprites = mergeSprites(games);

    // Keep the first start screen and last ending screen; discard the reserved
    // screens at the boundaries of every game between them.
    const mergedLevels = [
        ...games[0].levels.slice(0, -1),
        ...games.slice(1, -1).flatMap(game => game.levels.slice(1, -1)),
        ...games[games.length - 1].levels.slice(1)
    ];

    // 2. Neues kombiniertes Datenobjekt erstellen (nutzt die Basis von Spiel 1)
    const mergedData = {
        ...games[0],
        levels: mergedLevels,
        sprites: mergedSprites,
        gamesName: games.map((game, index) => game.gamesName || `Game ${index + 1}`).join(" + ")
    };

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
    const files = Array.from(document.getElementById("games").files);
    const statusDiv = document.getElementById("status");

    if (files.length < 2) {
        statusDiv.innerText = "Bitte wähle mindestens zwei Spiel-Dateien aus.";
        return;
    }

    try {
        statusDiv.innerText = "Spiele werden zusammengefügt...";

        // 1. Spiele datenmäßig mergen
        const mergedData = await mergeGames(files);

        // 2. Originaltext von Spiel 1 als HTML-Gerüst holen
        const templateHtml = await files[0].text();

        // 3. Neues HTML mit den gemergten Daten bauen
        const finalHtml = buildMergedHtml(templateHtml, mergedData);

        // 4. Download starten
        const safeFileName = (mergedData.gamesName || "Merged_Game").replace(/[^a-z0-9_-]/gi, '_');
        downloadHtmlFile(safeFileName, finalHtml);

        statusDiv.innerText = "Erfolgreich! Die Datei wurde heruntergeladen (" + (mergedData.levels.length - 2) + " spielbare Level).";

    } catch (error) {
        console.error(error);
        statusDiv.innerText = "Fehler beim Mergen: " + error.message;
    }
});

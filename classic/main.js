// Funktion zum Extrahieren der JSON-Daten aus einer Pocket-Platformer-HTML-Datei
const MERGER_SOURCES_KEY = "pocketPlatformMergerSources";

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

function expandEditableGames(game, fileName) {
    if (Object.hasOwn(game, MERGER_SOURCES_KEY)) {
        const sourceGames = game[MERGER_SOURCES_KEY];
        if (!Array.isArray(sourceGames) || sourceGames.length < 2) {
            throw new Error(`${fileName} contains invalid editable merge data.`);
        }
        return sourceGames.flatMap(sourceGame => expandEditableGames(sourceGame, fileName));
    }

    if (!Array.isArray(game.levels) || game.levels.length < 2) {
        throw new Error(`${fileName} does not contain valid game levels.`);
    }

    const names = typeof game.gamesName === "string"
        ? game.gamesName.split(/\s+\+\s+/).map(name => name.trim()).filter(Boolean)
        : [];
    const playableLevelCount = game.levels.length - 2;
    if (names.length > 1 && playableLevelCount > 0 && playableLevelCount % names.length === 0) {
        const levelsPerGame = playableLevelCount / names.length;
        return names.map((name, index) => ({
            ...game,
            gamesName: name,
            levels: [
                JSON.parse(JSON.stringify(game.levels[0])),
                ...JSON.parse(JSON.stringify(game.levels.slice(
                    1 + index * levelsPerGame,
                    1 + (index + 1) * levelsPerGame
                ))),
                JSON.parse(JSON.stringify(game.levels[game.levels.length - 1]))
            ]
        }));
    }

    return [game];
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
function mergeGames(games) {
    if (games.length < 2) {
        throw new Error("Bitte wähle mindestens zwei Spiel-Dateien aus.");
    }

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

    const newDataString = `\n  const allData = ${JSON.stringify(mergedData).replace(/</g, "\\u003c")}\n  `;
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

const selectedGames = [];
const gamesInput = document.getElementById("games");
const openMergedGameInput = document.getElementById("openMergedGame");
const gamesList = document.getElementById("gamesList");
const gameCount = document.getElementById("gameCount");
const gameNameInput = document.getElementById("gameName");
const mergeButton = document.getElementById("mergeButton");
const statusDiv = document.getElementById("status");
let isMerging = false;
let pendingFileLoads = 0;

function renderGamesList() {
    gamesList.replaceChildren();
    gameCount.textContent = `${selectedGames.length} ${selectedGames.length === 1 ? "Spiel" : "Spiele"}`;
    mergeButton.disabled = isMerging || pendingFileLoads > 0 || selectedGames.length < 2;

    if (selectedGames.length === 0) {
        const emptyState = document.createElement("li");
        emptyState.className = "empty-state";
        emptyState.textContent = "Noch keine Spiele hinzugefügt.";
        gamesList.appendChild(emptyState);
        return;
    }

    selectedGames.forEach((entry, index) => {
        const row = document.createElement("li");
        row.className = "game-row";

        const number = document.createElement("span");
        number.className = "game-number";
        number.textContent = String(index + 1);
        number.setAttribute("aria-label", `Spiel ${index + 1}`);

        const gameName = document.createElement("input");
        gameName.className = "game-label";
        gameName.type = "text";
        gameName.maxLength = 80;
        gameName.value = entry.data.gamesName;
        gameName.setAttribute("aria-label", `Name von Spiel ${index + 1}`);
        gameName.addEventListener("input", () => {
            entry.data.gamesName = gameName.value;
        });

        const actions = document.createElement("div");
        actions.className = "row-actions";

        const moveUpButton = document.createElement("button");
        moveUpButton.type = "button";
        moveUpButton.textContent = "↑";
        moveUpButton.title = "Nach oben verschieben";
        moveUpButton.setAttribute("aria-label", `${entry.data.gamesName} nach oben verschieben`);
        moveUpButton.disabled = index === 0;
        moveUpButton.addEventListener("click", () => moveGame(index, -1));

        const moveDownButton = document.createElement("button");
        moveDownButton.type = "button";
        moveDownButton.textContent = "↓";
        moveDownButton.title = "Nach unten verschieben";
        moveDownButton.setAttribute("aria-label", `${entry.data.gamesName} nach unten verschieben`);
        moveDownButton.disabled = index === selectedGames.length - 1;
        moveDownButton.addEventListener("click", () => moveGame(index, 1));

        const removeButton = document.createElement("button");
        removeButton.type = "button";
        removeButton.className = "remove-game";
        removeButton.textContent = "×";
        removeButton.title = "Spiel entfernen";
        removeButton.setAttribute("aria-label", `${entry.data.gamesName} entfernen`);
        removeButton.addEventListener("click", () => {
            selectedGames.splice(index, 1);
            renderGamesList();
        });

        actions.append(moveUpButton, moveDownButton, removeButton);
        row.append(number, gameName, actions);
        gamesList.appendChild(row);
    });
}

function moveGame(index, offset) {
    const targetIndex = index + offset;
    if (targetIndex < 0 || targetIndex >= selectedGames.length) {
        return;
    }

    [selectedGames[index], selectedGames[targetIndex]] =
        [selectedGames[targetIndex], selectedGames[index]];
    renderGamesList();
}

async function loadGames(files, replace = false) {
    if (files.length === 0) {
        return;
    }

    const errors = [];
    pendingFileLoads++;
    renderGamesList();
    const loadedGames = [];
    let openedGameData;

    try {
        for (const file of files) {
            try {
                const gameData = await extractGameData(file);
                const editableGames = expandEditableGames(gameData, file.name);
                editableGames.forEach((data, index) => {
                    if (!data.gamesName) {
                        data.gamesName = editableGames.length > 1
                            ? `Game ${index + 1}`
                            : file.name.replace(/\.html?$/i, "");
                    }
                    loadedGames.push({ data, templateFile: file });
                });
                if (replace) {
                    openedGameData = gameData;
                }
            } catch (error) {
                errors.push(error.message);
            }
        }
    } finally {
        pendingFileLoads--;
    }

    if (replace && errors.length === 0) {
        selectedGames.splice(0, selectedGames.length, ...loadedGames);
        gameNameInput.value = openedGameData.gamesName || files[0].name.replace(/\.html?$/i, "");
    } else if (!replace) {
        selectedGames.push(...loadedGames);
    }

    renderGamesList();
    if (errors.length) {
        statusDiv.textContent = `Datei konnte nicht geöffnet werden: ${errors.join(" ")}`;
    } else if (replace && Object.hasOwn(openedGameData, MERGER_SOURCES_KEY)) {
        statusDiv.textContent = `${loadedGames.length} Spiele aus dem Merge geöffnet. Namen, Reihenfolge und enthaltene Spiele können bearbeitet werden.`;
    } else if (replace && loadedGames.length > 1) {
        statusDiv.textContent = `${loadedGames.length} Spiele anhand des Titels und der Level-Reihenfolge rekonstruiert. Bitte prüfe die Aufteilung, bevor du den Merge speicherst.`;
    } else if (replace) {
        statusDiv.textContent = "Dieses Spiel enthält keine gespeicherten Einzelspiele und konnte nicht zuverlässig aufgeteilt werden. Es wurde als ein Spiel geöffnet.";
    } else {
        statusDiv.textContent = "";
    }
}

gamesInput.addEventListener("change", () => {
    const files = Array.from(gamesInput.files);
    gamesInput.value = "";
    loadGames(files);
});

openMergedGameInput.addEventListener("change", () => {
    const file = openMergedGameInput.files[0];
    openMergedGameInput.value = "";
    if (file) {
        loadGames([file], true);
    }
});

mergeButton.addEventListener("click", async () => {
    const games = selectedGames.map(entry => entry.data);
    const templateFile = selectedGames[0]?.templateFile;
    const gameName = gameNameInput.value.trim();

    if (games.length < 2) {
        statusDiv.textContent = "Bitte füge mindestens zwei Spiel-Dateien hinzu.";
        return;
    }
    if (!gameName) {
        statusDiv.textContent = "Bitte gib dem fertigen Spiel einen Namen.";
        gameNameInput.focus();
        return;
    }

    isMerging = true;
    mergeButton.disabled = true;
    statusDiv.textContent = "Spiele werden zusammengefügt...";
    try {
        const editableSources = JSON.parse(JSON.stringify(games));
        const mergedData = mergeGames(games);
        mergedData[MERGER_SOURCES_KEY] = editableSources;
        mergedData.gamesName = gameName;
        const templateHtml = await templateFile.text();
        const finalHtml = buildMergedHtml(templateHtml, mergedData);
        const safeFileName = gameName.replace(/[^a-z0-9_-]/gi, "_");
        downloadHtmlFile(safeFileName || "Merged_Game", finalHtml);
        statusDiv.textContent = `Erfolgreich! „${gameName}“ wurde heruntergeladen (${mergedData.levels.length - 2} spielbare Level). Du kannst die Liste jetzt weiter bearbeiten und erneut mergen.`;
    } catch (error) {
        console.error(error);
        statusDiv.textContent = "Fehler beim Mergen: " + error.message;
    } finally {
        isMerging = false;
        renderGamesList();
    }
});

renderGamesList();

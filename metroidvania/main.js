const DATA_MARKER = "//allDataStart";
const MERGER_SOURCES_KEY = "pocketPlatformMergerSources";

async function extractGameData(file) {
    const html = await file.text();
    const startIndex = html.indexOf(DATA_MARKER);
    const endIndex = html.lastIndexOf(DATA_MARKER);

    if (startIndex === -1 || endIndex <= startIndex) {
        throw new Error(`${file.name} does not contain a PocketPlatformer game data block.`);
    }

    const dataBlock = html
        .slice(startIndex + DATA_MARKER.length, endIndex)
        .trim()
        .replace(/^const\s+allData\s*=\s*/, "");
    const gameData = JSON.parse(dataBlock);

    if (!gameData || typeof gameData !== "object" || !Array.isArray(gameData.levels)) {
        throw new Error(`${file.name} does not contain a valid levels array.`);
    }
    if (gameData.levels.length < 3) {
        throw new Error(`${file.name} needs a start screen, at least one room, and an ending screen.`);
    }

    return gameData;
}

function expandEditableGames(game, fileName) {
    if (Object.hasOwn(game, MERGER_SOURCES_KEY)) {
        const sourceGames = game[MERGER_SOURCES_KEY];
        if (!Array.isArray(sourceGames) || sourceGames.length < 2) {
            throw new Error(`${fileName} contains invalid editable merge data.`);
        }
        return sourceGames.flatMap(sourceGame => expandEditableGames(sourceGame, fileName));
    }

    if (!Array.isArray(game.levels) || game.levels.length < 3) {
        throw new Error(`${fileName} does not contain valid game levels.`);
    }

    const names = typeof game.gamesName === "string"
        ? game.gamesName.split(/\s+\+\s+/).map(name => name.trim()).filter(Boolean)
        : [];
    const playableLevelCount = game.levels.length - 2;
    if (names.length > 1 && playableLevelCount > 0 && playableLevelCount % names.length === 0) {
        const levelsPerGame = playableLevelCount / names.length;
        const startScreen = JSON.parse(JSON.stringify(game.levels[0]));
        const endingScreen = JSON.parse(JSON.stringify(game.levels[game.levels.length - 1]));

        return names.map((name, gameIndex) => {
            const firstSourceLevel = 1 + gameIndex * levelsPerGame;
            const sourceLevels = JSON.parse(JSON.stringify(game.levels.slice(
                firstSourceLevel,
                firstSourceLevel + levelsPerGame
            )));
            const positions = sourceLevels.map(level => parseRoomPosition(level.position));
            if (positions.some(position => !position)) {
                throw new Error(`${fileName} has invalid room positions and cannot be split automatically.`);
            }

            const minColumn = Math.min(...positions.map(position => position.column));
            sourceLevels.forEach((level, levelOffset) => {
                const position = positions[levelOffset];
                level.position = formatRoomPosition(position.column - minColumn, position.row);

                const remapExits = value => {
                    if (Array.isArray(value)) {
                        value.forEach(remapExits);
                        return;
                    }
                    if (!value || typeof value !== "object") {
                        return;
                    }
                    if (value.customExit && Number.isInteger(value.customExit.levelIndex)) {
                        const destination = value.customExit.levelIndex;
                        const firstRoom = firstSourceLevel;
                        const lastRoom = firstSourceLevel + levelsPerGame - 1;
                        value.customExit.levelIndex = destination >= firstRoom && destination <= lastRoom
                            ? destination - firstRoom + 1
                            : sourceLevels.length + 1;
                    }
                    Object.values(value).forEach(remapExits);
                };
                remapExits(level);
            });

            return {
                ...game,
                gamesName: name,
                levels: [
                    JSON.parse(JSON.stringify(startScreen)),
                    ...sourceLevels,
                    JSON.parse(JSON.stringify(endingScreen))
                ]
            };
        });
    }

    return [game];
}

function mapTargetLevel(levelIndex, gameIndex, levelMaps) {
    if (!Number.isInteger(levelIndex)
        || levelIndex < 0
        || levelIndex >= levelMaps[gameIndex].length
        || !Number.isInteger(levelMaps[gameIndex][levelIndex])) {
        throw new Error(`Game ${gameIndex + 1} has an exit to an invalid level (${levelIndex}).`);
    }

    return levelMaps[gameIndex][levelIndex];
}

function parseRoomPosition(position) {
    const match = typeof position === "string" && position.match(/^([a-z]+)([1-9]\d*)$/);
    if (!match) {
        return null;
    }

    let column = 0;
    for (const letter of match[1]) {
        column = column * 26 + letter.charCodeAt(0) - 96;
    }

    return { column: column - 1, row: Number(match[2]) };
}

function formatRoomPosition(column, row) {
    let remainingColumn = column;
    let letters = "";
    do {
        letters = String.fromCharCode(97 + remainingColumn % 26) + letters;
        remainingColumn = Math.floor(remainingColumn / 26) - 1;
    } while (remainingColumn >= 0);

    return `${letters}${row}`;
}

function remapLevelExits(level, gameIndex, levelMaps) {
    const visit = value => {
        if (Array.isArray(value)) {
            value.forEach(visit);
            return;
        }
        if (!value || typeof value !== "object") {
            return;
        }

        if (value.customExit && Object.hasOwn(value.customExit, "levelIndex")) {
            value.customExit.levelIndex = mapTargetLevel(value.customExit.levelIndex, gameIndex, levelMaps);
        }

        Object.values(value).forEach(visit);
    };

    visit(level);
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

function mergeGames(games) {
    if (games.length < 2) {
        throw new Error("Please select at least two game files.");
    }

    const sprites = mergeSprites(games);
    const startScreen = JSON.parse(JSON.stringify(games[0].levels[0]));
    startScreen.position = null;
    const levels = [startScreen];
    const levelMaps = games.map(() => []);
    const firstRoomIndices = [];
    let nextColumn = 0;

    games.forEach((game, gameIndex) => {
        const rooms = game.levels.slice(1, -1);
        if (rooms.length === 0) {
            throw new Error(`Game ${gameIndex + 1} does not contain any playable rooms.`);
        }
        const roomPositions = rooms.map((room, roomIndex) => {
            const position = parseRoomPosition(room.position);
            if (!position) {
                throw new Error(`Game ${gameIndex + 1}, room ${roomIndex + 1} has an invalid room position.`);
            }
            return position;
        });
        const uniquePositions = new Set(roomPositions.map(({ column, row }) => `${column},${row}`));
        if (uniquePositions.size !== roomPositions.length) {
            throw new Error(`Game ${gameIndex + 1} contains rooms with duplicate positions.`);
        }

        const minColumn = Math.min(...roomPositions.map(position => position.column));
        const maxColumn = Math.max(...roomPositions.map(position => position.column));
        const columnOffset = nextColumn - minColumn;
        const firstMergedRoom = levels.length;
        nextColumn = maxColumn + columnOffset + 1;
        firstRoomIndices[gameIndex] = firstMergedRoom;

        levelMaps[gameIndex][0] = 0;

        rooms.forEach((sourceRoom, roomIndex) => {
            const room = JSON.parse(JSON.stringify(sourceRoom));
            const position = roomPositions[roomIndex];
            room.position = formatRoomPosition(position.column + columnOffset, position.row);

            levelMaps[gameIndex][roomIndex + 1] = levels.length;
            levels.push(room);
        });
        levelMaps[gameIndex][game.levels.length - 1] = null;
    });

    const endingLevelIndex = levels.length;
    const endingScreen = JSON.parse(JSON.stringify(games[games.length - 1].levels[games[games.length - 1].levels.length - 1]));
    endingScreen.position = null;
    levels.push(endingScreen);

    games.forEach((game, gameIndex) => {
        levelMaps[gameIndex][game.levels.length - 1] =
            gameIndex === games.length - 1
                ? endingLevelIndex
                : firstRoomIndices[gameIndex + 1];
    });

    games.forEach((game, gameIndex) => {
        for (let sourceIndex = 1; sourceIndex < game.levels.length - 1; sourceIndex++) {
            remapLevelExits(levels[levelMaps[gameIndex][sourceIndex]], gameIndex, levelMaps);
        }
    });

    games.forEach((game, gameIndex) => {
        const destinationLevel = gameIndex === games.length - 1
            ? endingLevelIndex
            : firstRoomIndices[gameIndex + 1];
        let destinationFlagIndex;

        if (gameIndex < games.length - 1) {
            const nextGame = games[gameIndex + 1];
            for (let sourceIndex = 1; sourceIndex < nextGame.levels.length - 1; sourceIndex++) {
                const startFlag = (nextGame.levels[sourceIndex].levelObjects || [])
                    .find(levelObject => levelObject.type === "startFlag");
                if (startFlag) {
                    destinationFlagIndex = startFlag.extraAttributes?.flagIndex;
                    break;
                }
            }
        }

        for (let sourceIndex = 1; sourceIndex < game.levels.length - 1; sourceIndex++) {
            const mergedLevel = levels[levelMaps[gameIndex][sourceIndex]];
            (mergedLevel.levelObjects || []).forEach(levelObject => {
                if (levelObject.type !== "finishFlag") {
                    return;
                }

                const customExit = { levelIndex: destinationLevel };
                if (destinationFlagIndex) {
                    customExit.flagIndex = destinationFlagIndex;
                }
                const extraAttributes = levelObject.extraAttributes || (levelObject.extraAttributes = {});
                extraAttributes.customExit = customExit;
            });
        }
    });

    const effects = [];
    games.forEach((game, gameIndex) => {
        if (game.effects === undefined) {
            return;
        }
        if (!Array.isArray(game.effects)) {
            throw new Error(`Game ${gameIndex + 1} contains invalid effects data.`);
        }

        for (const sourceEffect of game.effects) {
            const effect = JSON.parse(JSON.stringify(sourceEffect));
            if (Array.isArray(effect.activeLevels)) {
                effect.activeLevels = effect.activeLevels.map(levelIndex =>
                    levelIndex === "allLevels"
                        ? levelIndex
                        : mapTargetLevel(levelIndex, gameIndex, levelMaps)
                );
            }
            effects.push(effect);
        }
    });

    return {
        ...games[0],
        levels,
        sprites,
        effects,
        endingMessage: games[games.length - 1].endingMessage || games[0].endingMessage,
        gamesName: games.map((game, index) => game.gamesName || `Game ${index + 1}`).join(" + ")
    };
}

function buildMergedHtml(templateHtml, mergedData) {
    const startIndex = templateHtml.indexOf(DATA_MARKER);
    const endIndex = templateHtml.lastIndexOf(DATA_MARKER);

    if (startIndex === -1 || endIndex <= startIndex) {
        throw new Error("Could not locate the game data block in the first selected file.");
    }

    const beforeData = templateHtml.slice(0, startIndex + DATA_MARKER.length);
    const afterData = templateHtml.slice(endIndex);
    const jsonData = JSON.stringify(mergedData).replace(/</g, "\\u003c");

    let mergedHtml = `${beforeData}\n  const allData = ${jsonData}\n  ${afterData}`;
    const hardcodedFinishExit = /PlayMode\.customExit\s*=\s*\{\s*levelIndex\s*:\s*WorldDataHandler\.levels\.length\s*-\s*1\s*}\s*;/;
    if (hardcodedFinishExit.test(mergedHtml)) {
        mergedHtml = mergedHtml.replace(
            hardcodedFinishExit,
            "PlayMode.customExit = this.customExit || { levelIndex: WorldDataHandler.levels.length - 1 };"
        );
    } else if (!/PlayMode\.customExit\s*=\s*this\.customExit\b/.test(mergedHtml)) {
        throw new Error("The selected game template does not support custom finish-flag exits.");
    }

    mergedHtml = mergedHtml.replace(
        /this\.ensureUniqueFlags\(ObjectTypes\.(?:START|FINISH)_FLAG\);/g,
        ""
    );

    return mergedHtml.replace(/<meta\b[^>]*>/gi, tag => {
        if (!/\bname=["']viewport["']/i.test(tag)) {
            return tag;
        }

        return tag.replace(/\bcontent=(["'])(.*?)\1/i, (_, quote, content) =>
            `content=${quote}${content.replace(/;\s*(?=[\w-]+\s*=)/g, ", ")}${quote}`
        );
    });
}

function downloadHtmlFile(filename, html) {
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${filename}.html`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const selectedGames = [];
const gamesInput = document.getElementById("games");
const openMergedGameInput = document.getElementById("openMergedGame");
const gamesList = document.getElementById("gamesList");
const gameCount = document.getElementById("gameCount");
const gameNameInput = document.getElementById("gameName");
const mergeButton = document.getElementById("mergeButton");
const status = document.getElementById("status");
let isMerging = false;
let pendingFileLoads = 0;

function renderGamesList() {
    gamesList.replaceChildren();
    gameCount.textContent = `${selectedGames.length} ${selectedGames.length === 1 ? "game" : "games"}`;
    mergeButton.disabled = isMerging || pendingFileLoads > 0 || selectedGames.length < 2;

    if (selectedGames.length === 0) {
        const emptyState = document.createElement("li");
        emptyState.className = "empty-state";
        emptyState.textContent = "No games added yet.";
        gamesList.appendChild(emptyState);
        return;
    }

    selectedGames.forEach((entry, index) => {
        const row = document.createElement("li");
        row.className = "game-row";

        const number = document.createElement("span");
        number.className = "game-number";
        number.textContent = String(index + 1);
        number.setAttribute("aria-label", `Game ${index + 1}`);

        const gameName = document.createElement("input");
        gameName.className = "game-label";
        gameName.type = "text";
        gameName.maxLength = 80;
        gameName.value = entry.data.gamesName;
        gameName.setAttribute("aria-label", `Name of game ${index + 1}`);
        gameName.addEventListener("input", () => {
            entry.data.gamesName = gameName.value;
        });

        const actions = document.createElement("div");
        actions.className = "row-actions";

        const moveUpButton = document.createElement("button");
        moveUpButton.type = "button";
        moveUpButton.textContent = "↑";
        moveUpButton.title = "Move up";
        moveUpButton.setAttribute("aria-label", `Move ${entry.data.gamesName} up`);
        moveUpButton.disabled = index === 0;
        moveUpButton.addEventListener("click", () => moveGame(index, -1));

        const moveDownButton = document.createElement("button");
        moveDownButton.type = "button";
        moveDownButton.textContent = "↓";
        moveDownButton.title = "Move down";
        moveDownButton.setAttribute("aria-label", `Move ${entry.data.gamesName} down`);
        moveDownButton.disabled = index === selectedGames.length - 1;
        moveDownButton.addEventListener("click", () => moveGame(index, 1));

        const removeButton = document.createElement("button");
        removeButton.type = "button";
        removeButton.className = "remove-game";
        removeButton.textContent = "×";
        removeButton.title = "Remove game";
        removeButton.setAttribute("aria-label", `Remove ${entry.data.gamesName}`);
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
        status.textContent = `Could not open file: ${errors.join(" ")}`;
    } else if (replace && Object.hasOwn(openedGameData, MERGER_SOURCES_KEY)) {
        status.textContent = `Opened ${loadedGames.length} games from the merge. You can edit their names, order, and contents.`;
    } else if (replace && loadedGames.length > 1) {
        status.textContent = `Reconstructed ${loadedGames.length} games from the title and room order. Please verify the split before saving.`;
    } else if (replace) {
        status.textContent = "This game has no saved component games and could not be reliably split. It was opened as one game.";
    } else {
        status.textContent = "";
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
        status.textContent = "Please add at least two game files.";
        return;
    }
    if (!gameName) {
        status.textContent = "Please give the merged game a name.";
        gameNameInput.focus();
        return;
    }

    isMerging = true;
    mergeButton.disabled = true;
    status.textContent = "Merging games...";
    try {
        const editableSources = JSON.parse(JSON.stringify(games));
        const mergedData = mergeGames(games);
        mergedData[MERGER_SOURCES_KEY] = editableSources;
        mergedData.gamesName = gameName;
        const templateHtml = await templateFile.text();
        const mergedHtml = buildMergedHtml(templateHtml, mergedData);
        const filename = gameName.replace(/[^a-z0-9_-]/gi, "_");
        downloadHtmlFile(filename || "Merged_Metroidvania", mergedHtml);
        status.textContent = `Merged successfully: “${gameName}” (${mergedData.levels.length - 2} rooms). You can keep editing the list and merge again.`;
    } catch (error) {
        console.error(error);
        status.textContent = `Merge failed: ${error.message}`;
    } finally {
        isMerging = false;
        renderGamesList();
    }
});

renderGamesList();

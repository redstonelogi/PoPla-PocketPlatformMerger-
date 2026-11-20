const DATA_MARKER = "//allDataStart";

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

function mergeGames(games) {
    if (games.length < 2) {
        throw new Error("Please select at least two game files.");
    }

    const startScreen = JSON.parse(JSON.stringify(games[0].levels[0]));
    startScreen.position = null;
    const levels = [startScreen];
    const levelMaps = games.map(() => []);
    const firstRoomIndices = [];
    const sourceRoomLevels = [];
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
            sourceRoomLevels.push({ gameIndex, sourceIndex: roomIndex + 1 });
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

    let startFlagKept = false;
    let finishFlagKept = false;
    const finalGameIndex = games.length - 1;
    const finalGameHasFinishFlag = sourceRoomLevels.some(({ gameIndex, sourceIndex }) =>
        gameIndex === finalGameIndex
        && (games[gameIndex].levels[sourceIndex].levelObjects || [])
            .some(levelObject => levelObject.type === "finishFlag")
    );

    sourceRoomLevels.forEach(({ gameIndex, sourceIndex }, roomOffset) => {
        const room = levels[roomOffset + 1];
        room.levelObjects = (room.levelObjects || []).filter(levelObject => {
            if (levelObject.type === "startFlag") {
                if (startFlagKept) {
                    return false;
                }
                startFlagKept = true;
            }

            if (levelObject.type === "finishFlag") {
                if (finalGameHasFinishFlag && gameIndex !== finalGameIndex) {
                    return false;
                }
                if (finishFlagKept) {
                    return false;
                }
                finishFlagKept = true;
            }

            return true;
        });
    });

    games.forEach((game, gameIndex) => {
        for (let sourceIndex = 1; sourceIndex < game.levels.length - 1; sourceIndex++) {
            remapLevelExits(levels[levelMaps[gameIndex][sourceIndex]], gameIndex, levelMaps);
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

    return `${beforeData}\n  const allData = ${jsonData}\n  ${afterData}`;
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

document.getElementById("mergeButton").addEventListener("click", async () => {
    const files = Array.from(document.getElementById("games").files);
    const status = document.getElementById("status");
    const button = document.getElementById("mergeButton");

    if (files.length < 2) {
        status.textContent = "Please select at least two game files.";
        return;
    }

    button.disabled = true;
    status.textContent = "Merging games...";
    try {
        const games = await Promise.all(files.map(extractGameData));
        const mergedData = mergeGames(games);
        const templateHtml = await files[0].text();
        const mergedHtml = buildMergedHtml(templateHtml, mergedData);
        const filename = (mergedData.gamesName || "Merged_Metroidvania").replace(/[^a-z0-9_-]/gi, "_");
        downloadHtmlFile(filename, mergedHtml);
        status.textContent = `Merged successfully: ${mergedData.levels.length - 2} rooms.`;
    } catch (error) {
        console.error(error);
        status.textContent = `Merge failed: ${error.message}`;
    } finally {
        button.disabled = false;
    }
});

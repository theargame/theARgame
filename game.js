// AR Connect 4 — game.js
// A-Frame 1.5.0 + Supabase JS v2 (loaded as window.supabase global)
// No bundler, pure vanilla JS

(function () {
  'use strict';

  // ─── Config ────────────────────────────────────────────────────────────────
  var SUPABASE_URL = 'https://oksaekiomphiwdxoeojo.supabase.co';
  var SUPABASE_ANON_KEY =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9rc2Fla2lvbXBoaXdkeG9lb2pvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA1NDgzNzEsImV4cCI6MjA5NjEyNDM3MX0.je2ZzdbFUSP2xcQAHYczIxQicKOMmLlrkXKfxsrH3i4';

  // ─── Board constants ────────────────────────────────────────────────────────
  var COLS = 7;
  var ROWS = 6;
  var CELL_W = 1.2;  // horizontal spacing
  var CELL_H = 1.1;  // vertical spacing
  var BOARD_Z = -4;  // distance from camera
  var BOARD_ORIGIN_X = -((COLS - 1) / 2) * CELL_W; // left edge
  var BOARD_ORIGIN_Y = -((ROWS - 1) / 2) * CELL_H; // bottom edge

  // ─── Runtime state ─────────────────────────────────────────────────────────
  var db = null;          // Supabase client
  var playerId = null;    // current player's UUID
  var gameId = null;      // current game UUID
  var playerSide = null;  // 1 = red, 2 = yellow
  var currentBoard = new Array(42).fill(0);
  var gameSubscription = null;
  var movesSubscription = null;

  // ─── Supabase init ──────────────────────────────────────────────────────────
  function initSupabase() {
    db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }

  // ─── Panel management ──────────────────────────────────────────────────────
  function showPanel(name) {
    var panels = ['lobby', 'waiting', 'win-screen'];
    panels.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.style.display = (id === name) ? 'flex' : 'none';
    });
    // Show/hide status bar and AR board
    var statusBar = document.getElementById('status-bar');
    var boardRoot = document.getElementById('board-root');
    if (name === null) {
      // in-game
      if (statusBar) statusBar.style.display = 'flex';
      if (boardRoot) boardRoot.setAttribute('visible', 'true');
    } else {
      if (statusBar) statusBar.style.display = 'none';
      if (boardRoot) boardRoot.setAttribute('visible', name !== 'lobby' && name !== 'waiting' ? 'true' : 'false');
    }
  }

  function setLobbyError(msg) {
    var el = document.getElementById('lobby-error');
    if (el) el.textContent = msg || '';
  }

  // ─── Upsert player ─────────────────────────────────────────────────────────
  async function upsertPlayer(username) {
    var trimmed = username.trim();
    if (!trimmed) throw new Error('Username is required.');

    // Try to get existing
    var existing = await db
      .from('players')
      .select('id')
      .eq('username', trimmed)
      .maybeSingle();

    if (existing.error) throw existing.error;

    if (existing.data) {
      return existing.data.id;
    }

    // Insert new
    var inserted = await db
      .from('players')
      .insert({ username: trimmed })
      .select('id')
      .single();

    if (inserted.error) throw inserted.error;
    return inserted.data.id;
  }

  // ─── Create game ───────────────────────────────────────────────────────────
  async function createGame() {
    var username = (document.getElementById('username-input') || {}).value || '';
    setLobbyError('');

    try {
      var pid = await upsertPlayer(username);
      playerId = pid;
      playerSide = 1; // red

      var res = await db
        .from('games')
        .insert({
          player_red: pid,
          board: new Array(42).fill(0),
          current_turn: 1,
          status: 'waiting',
          winner: null
        })
        .select('id')
        .single();

      if (res.error) throw res.error;

      gameId = res.data.id;

      var shareEl = document.getElementById('share-game-id');
      if (shareEl) shareEl.textContent = gameId;

      showPanel('waiting');
      subscribeToGame();

    } catch (err) {
      setLobbyError(err.message || 'Failed to create game.');
    }
  }

  // ─── Join game ─────────────────────────────────────────────────────────────
  async function joinGame() {
    var username = (document.getElementById('username-input') || {}).value || '';
    var gid = ((document.getElementById('game-id-input') || {}).value || '').trim();
    setLobbyError('');

    if (!gid) {
      setLobbyError('Please enter a game ID.');
      return;
    }

    try {
      var pid = await upsertPlayer(username);
      playerId = pid;
      playerSide = 2; // yellow

      // Verify game exists and is waiting
      var check = await db
        .from('games')
        .select('*')
        .eq('id', gid)
        .eq('status', 'waiting')
        .single();

      if (check.error || !check.data) {
        setLobbyError('Game not found or already started.');
        return;
      }

      if (check.data.player_red === pid) {
        setLobbyError('You cannot join your own game.');
        return;
      }

      var update = await db
        .from('games')
        .update({
          player_yellow: pid,
          status: 'playing',
          current_turn: 1
        })
        .eq('id', gid)
        .select('*')
        .single();

      if (update.error) throw update.error;

      gameId = gid;
      currentBoard = update.data.board || new Array(42).fill(0);

      startGame(update.data);

    } catch (err) {
      setLobbyError(err.message || 'Failed to join game.');
    }
  }

  // ─── Start game ────────────────────────────────────────────────────────────
  function startGame(gameRow) {
    currentBoard = gameRow.board || new Array(42).fill(0);
    buildBoard();
    renderBoard(currentBoard);
    updateStatusBar(gameRow.current_turn, 0);
    showPanel(null);
    subscribeToGame();
    subscribeToMoves();
  }

  // ─── 3D board building ─────────────────────────────────────────────────────
  function buildBoard() {
    var boardRoot = document.getElementById('board-root');
    if (!boardRoot) return;

    // Clear existing children
    while (boardRoot.firstChild) {
      boardRoot.removeChild(boardRoot.firstChild);
    }

    // Slot cylinders
    for (var row = 0; row < ROWS; row++) {
      for (var col = 0; col < COLS; col++) {
        var slot = document.createElement('a-cylinder');
        slot.setAttribute('radius', 0.4);
        slot.setAttribute('height', 0.12);
        slot.setAttribute('segments-radial', 24);
        slot.setAttribute('color', '#222222');
        slot.setAttribute('opacity', 0.75);
        slot.setAttribute('transparent', 'true');
        slot.setAttribute('rotation', '90 0 0');

        var x = BOARD_ORIGIN_X + col * CELL_W;
        var y = BOARD_ORIGIN_Y + row * CELL_H;
        slot.setAttribute('position', x + ' ' + y + ' ' + BOARD_Z);
        slot.setAttribute('data-col', col);
        slot.setAttribute('data-row', row);
        slot.setAttribute('class', 'slot-piece');
        slot.setAttribute('id', 'slot-' + col + '-' + row);

        boardRoot.appendChild(slot);
      }
    }

    // Column hit zones — invisible tall boxes above each column
    for (var c = 0; c < COLS; c++) {
      var hitZone = document.createElement('a-box');
      var hx = BOARD_ORIGIN_X + c * CELL_W;
      var hy = 0; // vertically centred on board
      hitZone.setAttribute('width', CELL_W * 0.9);
      hitZone.setAttribute('height', ROWS * CELL_H + 0.5);
      hitZone.setAttribute('depth', 0.5);
      hitZone.setAttribute('position', hx + ' ' + hy + ' ' + BOARD_Z);
      hitZone.setAttribute('opacity', 0);
      hitZone.setAttribute('transparent', 'true');
      hitZone.setAttribute('class', 'col-hit');
      hitZone.setAttribute('data-col', c);
      hitZone.setAttribute('id', 'col-hit-' + c);

      hitZone.addEventListener('click', (function (col) {
        return function () {
          handleColumnClick(col);
        };
      }(c)));

      boardRoot.appendChild(hitZone);
    }
  }

  // ─── Render board state ────────────────────────────────────────────────────
  function renderBoard(board) {
    for (var row = 0; row < ROWS; row++) {
      for (var col = 0; col < COLS; col++) {
        var idx = row * COLS + col;
        var piece = board[idx];
        var slotEl = document.getElementById('slot-' + col + '-' + row);
        if (!slotEl) continue;

        if (piece === 1) {
          slotEl.setAttribute('color', '#e63946');
          slotEl.setAttribute('opacity', 1);
          slotEl.setAttribute('transparent', 'false');
        } else if (piece === 2) {
          slotEl.setAttribute('color', '#ffd60a');
          slotEl.setAttribute('opacity', 1);
          slotEl.setAttribute('transparent', 'false');
        } else {
          slotEl.setAttribute('color', '#222222');
          slotEl.setAttribute('opacity', 0.75);
          slotEl.setAttribute('transparent', 'true');
        }
      }
    }
  }

  // ─── Status bar ────────────────────────────────────────────────────────────
  function updateStatusBar(currentTurn, moveCount) {
    var indicator = document.getElementById('turn-indicator');
    var moveCountEl = document.getElementById('move-count');

    if (indicator) {
      if (currentTurn === playerSide) {
        indicator.textContent = 'Your turn (' + (playerSide === 1 ? 'Red' : 'Yellow') + ')';
        indicator.style.color = playerSide === 1 ? '#e63946' : '#ffd60a';
      } else {
        var oppColor = currentTurn === 1 ? 'Red' : 'Yellow';
        indicator.textContent = oppColor + '\'s turn';
        indicator.style.color = currentTurn === 1 ? '#e63946' : '#ffd60a';
      }
    }

    if (moveCountEl) {
      moveCountEl.textContent = 'Moves: ' + (moveCount || 0);
    }
  }

  // ─── Column click handler ──────────────────────────────────────────────────
  async function handleColumnClick(col) {
    if (!gameId || !playerId) return;

    // Fetch latest game state
    var res = await db
      .from('games')
      .select('*')
      .eq('id', gameId)
      .single();

    if (res.error || !res.data) return;
    var game = res.data;

    if (game.status !== 'playing') return;
    if (game.current_turn !== playerSide) return;

    // Verify it's this player's turn
    var expectedPlayer = playerSide === 1 ? game.player_red : game.player_yellow;
    if (expectedPlayer !== playerId) return;

    // Find lowest empty row in column
    var board = game.board.slice();
    var landRow = findDropRow(board, col);
    if (landRow === -1) return; // column full

    // Place piece
    var idx = landRow * COLS + col;
    board[idx] = playerSide;

    // Check win
    var won = checkWin(board, landRow, col, playerSide);
    var draw = !won && board.every(function (v) { return v !== 0; });

    var nextTurn = playerSide === 1 ? 2 : 1;
    var newStatus = won ? 'done' : (draw ? 'done' : 'playing');
    var winner = won ? playerSide : null;

    // Count moves
    var movesCountRes = await db
      .from('moves')
      .select('id', { count: 'exact', head: true })
      .eq('game_id', gameId);

    var moveNumber = (movesCountRes.count || 0) + 1;

    // Insert move
    var moveRes = await db.from('moves').insert({
      game_id: gameId,
      player_id: playerId,
      column_index: col,
      row_index: landRow,
      piece: playerSide,
      move_number: moveNumber
    });

    if (moveRes.error) {
      console.error('Move insert error:', moveRes.error);
      return;
    }

    // Update game
    var updatePayload = {
      board: board,
      current_turn: nextTurn,
      status: newStatus,
      updated_at: new Date().toISOString()
    };
    if (winner !== null) updatePayload.winner = winner;

    var updateRes = await db
      .from('games')
      .update(updatePayload)
      .eq('id', gameId);

    if (updateRes.error) {
      console.error('Game update error:', updateRes.error);
    }
  }

  // ─── Drop row finder ───────────────────────────────────────────────────────
  function findDropRow(board, col) {
    // Row 0 = bottom; find lowest (smallest row index) empty cell
    for (var row = 0; row < ROWS; row++) {
      var idx = row * COLS + col;
      if (board[idx] === 0) return row;
    }
    return -1; // full
  }

  // ─── Win detection ─────────────────────────────────────────────────────────
  function checkWin(board, row, col, piece) {
    // Check all four directions from the last placed piece
    var directions = [
      [0, 1],   // horizontal
      [1, 0],   // vertical
      [1, 1],   // diagonal /
      [1, -1]   // diagonal \
    ];

    for (var d = 0; d < directions.length; d++) {
      var dr = directions[d][0];
      var dc = directions[d][1];
      var count = 1;

      // Positive direction
      count += countDir(board, row, col, dr, dc, piece);
      // Negative direction
      count += countDir(board, row, col, -dr, -dc, piece);

      if (count >= 4) return true;
    }
    return false;
  }

  function countDir(board, row, col, dr, dc, piece) {
    var count = 0;
    var r = row + dr;
    var c = col + dc;
    while (r >= 0 && r < ROWS && c >= 0 && c < COLS) {
      var idx = r * COLS + c;
      if (board[idx] === piece) {
        count++;
        r += dr;
        c += dc;
      } else {
        break;
      }
    }
    return count;
  }

  // Full-board win scan (used after realtime updates)
  function findWinnerOnBoard(board) {
    for (var row = 0; row < ROWS; row++) {
      for (var col = 0; col < COLS; col++) {
        var piece = board[row * COLS + col];
        if (piece === 0) continue;
        if (checkWin(board, row, col, piece)) return piece;
      }
    }
    return null;
  }

  // ─── Win screen ────────────────────────────────────────────────────────────
  function showWinScreen(winner, draw) {
    var msgEl = document.getElementById('win-message');
    var subEl = document.getElementById('win-sub');

    if (draw) {
      if (msgEl) msgEl.textContent = "It's a Draw!";
      if (subEl) subEl.textContent = 'Nobody wins this time.';
    } else if (winner === playerSide) {
      if (msgEl) msgEl.textContent = 'You Win!';
      if (subEl) subEl.textContent = (playerSide === 1 ? 'Red' : 'Yellow') + ' player wins!';
    } else {
      var winnerColor = winner === 1 ? 'Red' : 'Yellow';
      if (msgEl) msgEl.textContent = winnerColor + ' Wins!';
      if (subEl) subEl.textContent = 'Better luck next time.';
    }

    showPanel('win-screen');
  }

  // ─── Realtime subscriptions ────────────────────────────────────────────────
  function subscribeToGame() {
    if (gameSubscription) {
      db.removeChannel(gameSubscription);
    }

    gameSubscription = db
      .channel('game-' + gameId)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'games',
          filter: 'id=eq.' + gameId
        },
        function (payload) {
          handleGameUpdate(payload.new);
        }
      )
      .subscribe();
  }

  function subscribeToMoves() {
    if (movesSubscription) {
      db.removeChannel(movesSubscription);
    }

    movesSubscription = db
      .channel('moves-' + gameId)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'moves',
          filter: 'game_id=eq.' + gameId
        },
        function (payload) {
          // Secondary sync — board state comes from game UPDATE
          // but we use this to keep move count fresh
          var moveCountEl = document.getElementById('move-count');
          if (moveCountEl && payload.new && payload.new.move_number) {
            moveCountEl.textContent = 'Moves: ' + payload.new.move_number;
          }
        }
      )
      .subscribe();
  }

  // ─── Game update handler ───────────────────────────────────────────────────
  function handleGameUpdate(game) {
    if (!game) return;

    var board = game.board || new Array(42).fill(0);
    currentBoard = board;

    // If we're in waiting state and it just became playing, start the game
    if (game.status === 'playing') {
      var boardRoot = document.getElementById('board-root');
      var rootVisible = boardRoot && boardRoot.getAttribute('visible') === 'true';

      if (!rootVisible) {
        // We were the creator waiting — game just started
        buildBoard();
        renderBoard(board);
        updateStatusBar(game.current_turn, 0);
        showPanel(null);
        subscribeToMoves();
        return;
      }
    }

    renderBoard(board);

    if (game.status === 'done') {
      var winner = game.winner;
      var isDraw = !winner && board.every(function (v) { return v !== 0; });
      showWinScreen(winner, isDraw);
      unsubscribeAll();
      return;
    }

    // Count moves on board for display
    var filledCells = board.filter(function (v) { return v !== 0; }).length;
    updateStatusBar(game.current_turn, filledCells);
  }

  function unsubscribeAll() {
    if (gameSubscription) {
      db.removeChannel(gameSubscription);
      gameSubscription = null;
    }
    if (movesSubscription) {
      db.removeChannel(movesSubscription);
      movesSubscription = null;
    }
  }

  // ─── Copy game ID ──────────────────────────────────────────────────────────
  function copyGameId() {
    if (!gameId) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(gameId).then(function () {
        var btn = document.getElementById('btn-copy');
        if (btn) {
          var original = btn.textContent;
          btn.textContent = 'Copied!';
          setTimeout(function () { btn.textContent = original; }, 1500);
        }
      });
    } else {
      // Fallback
      var ta = document.createElement('textarea');
      ta.value = gameId;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
  }

  // ─── Show/hide join section ────────────────────────────────────────────────
  function toggleJoinSection(show) {
    var section = document.getElementById('join-section');
    if (section) section.style.display = show ? 'flex' : 'none';
  }

  // ─── Boot ──────────────────────────────────────────────────────────────────
  function boot() {
    initSupabase();
    showPanel('lobby');

    // Lobby buttons
    var btnCreate = document.getElementById('btn-create');
    if (btnCreate) {
      btnCreate.addEventListener('click', function () { createGame(); });
    }

    var btnJoin = document.getElementById('btn-join');
    if (btnJoin) {
      btnJoin.addEventListener('click', function () {
        toggleJoinSection(true);
      });
    }

    var btnJoinConfirm = document.getElementById('btn-join-confirm');
    if (btnJoinConfirm) {
      btnJoinConfirm.addEventListener('click', function () { joinGame(); });
    }

    // Copy button
    var btnCopy = document.getElementById('btn-copy');
    if (btnCopy) {
      btnCopy.addEventListener('click', copyGameId);
    }

    // New game / play again
    var btnNewGame = document.getElementById('btn-new-game');
    if (btnNewGame) {
      btnNewGame.addEventListener('click', function () {
        window.location.reload();
      });
    }

    // Enter key on game-id-input
    var gameIdInput = document.getElementById('game-id-input');
    if (gameIdInput) {
      gameIdInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') joinGame();
      });
    }

    // Enter key on username
    var usernameInput = document.getElementById('username-input');
    if (usernameInput) {
      usernameInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          var joinSection = document.getElementById('join-section');
          var joinVisible = joinSection && joinSection.style.display !== 'none';
          if (joinVisible) {
            joinGame();
          } else {
            createGame();
          }
        }
      });
    }

    // Hide join section initially
    toggleJoinSection(false);
  }

  // Boot on DOM ready — don't wait for A-Frame (buttons/Supabase don't need it)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();

package snake;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Random;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.logging.Level;
import java.util.logging.Logger;


public final class GameService {

    private static final Logger LOG = Logger.getLogger(GameService.class.getName());
    private static final long TICK_INTERVAL_MS = 15L;

    private final Map<String, Game> games = new ConcurrentHashMap<>();
    /** Guarded by {@code streams}. */
    private final Map<String, Set<SnapshotStream>> streams = new HashMap<>();
    private final ScheduledExecutorService ticker;
    private final Random random = new Random();

    private volatile int highScore;

    public GameService() {
        ticker = Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, "snake-ticker");
            thread.setDaemon(true);
            return thread;
        });
        ticker.scheduleAtFixedRate(this::tickAll, 0L, TICK_INTERVAL_MS, TimeUnit.MILLISECONDS);
    }

    /**
     * Eine offene SSE-Verbindung. Der Ticker legt hier neue Zustands-Snapshots ab;
     * der HTTP-Thread nimmt sie blockierend (mit Timeout fuer Keepalive) entgegen.
     */
    public static final class SnapshotStream {

        static final String CLOSE = "\u0000";

        private final BlockingQueue<String> queue = new ArrayBlockingQueue<>(8);
        private final String gameId;
        private long lastVersion;
        private volatile boolean closed;

        private SnapshotStream(String gameId, long version, String initialSnapshot) {
            this.gameId = gameId;
            this.lastVersion = version;
            queue.offer(initialSnapshot);
        }

        public String gameId() {
            return gameId;
        }

        void push(String json) {
            if (closed) {
                return;
            }
            if (!queue.offer(json)) {
                // Nur die neueste Version ist interessant – alter Zustand wuerde
                // den Client nur zurueckwerfen.
                queue.poll();
                queue.offer(json);
            }
        }

        void close() {
            closed = true;
            queue.clear();
            queue.offer(CLOSE);
        }

        /** Liefert den naechsten Snapshot oder null bei Timeout. */
        String await(long timeoutMs) throws InterruptedException {
            if (closed) {
                return CLOSE;
            }
            return queue.poll(timeoutMs, TimeUnit.MILLISECONDS);
        }
    }

    public Game create() {
        String id = UUID.randomUUID().toString().replace("-", "").substring(0, 12);
        Game game = new Game(id, Game.DEFAULT_WIDTH, Game.DEFAULT_HEIGHT, random);
        games.put(id, game);
        return game;
    }

    public Game find(String id) {
        return id == null ? null : games.get(id);
    }

    public int highScore() {
        return highScore;
    }

    public SnapshotStream subscribe(String id) {
        Game game = games.get(id);
        if (game == null) {
            return null;
        }
        SnapshotStream stream = new SnapshotStream(id, game.version(), game.toJson(highScore));
        synchronized (streams) {
            streams.computeIfAbsent(id, ignored -> new HashSet<>()).add(stream);
        }
        return stream;
    }

    public void unsubscribe(SnapshotStream stream) {
        synchronized (streams) {
            Set<SnapshotStream> gameStreams = streams.get(stream.gameId());
            if (gameStreams != null) {
                gameStreams.remove(stream);
                if (gameStreams.isEmpty()) {
                    streams.remove(stream.gameId());
                }
            }
        }
        stream.close();
    }

    public void shutdown() {
        ticker.shutdownNow();
        synchronized (streams) {
            for (Set<SnapshotStream> gameStreams : streams.values()) {
                for (SnapshotStream stream : gameStreams) {
                    stream.close();
                }
            }
            streams.clear();
        }
    }

    private void tickAll() {
        long now = System.currentTimeMillis();
        int previousHighScore = highScore;
        for (Game game : games.values()) {
            try {
                game.tick(now);
                int score = game.getScore();
                if (score > highScore) {
                    highScore = score;
                }
            } catch (RuntimeException exception) {
                LOG.log(Level.WARNING, "Tick fehlgeschlagen", exception);
            }
        }

        boolean highScoreChanged = highScore != previousHighScore;
        synchronized (streams) {
            for (Set<SnapshotStream> gameStreams : streams.values()) {
                for (SnapshotStream stream : gameStreams) {
                    Game game = games.get(stream.gameId());
                    if (game == null) {
                        continue;
                    }
                    // Der Rekord ist global und erhoeht nicht die Spiel-Version.
                    if (highScoreChanged) {
                        stream.lastVersion = -1L;
                    }
                    long version = game.version();
                    if (version != stream.lastVersion) {
                        stream.lastVersion = version;
                        stream.push(game.toJson(highScore));
                    }
                }
            }
        }
    }
}

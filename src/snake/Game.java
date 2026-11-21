package snake;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashSet;
import java.util.List;
import java.util.Random;
import java.util.Set;


public final class Game {

    public static final int DEFAULT_WIDTH = 23;
    public static final int DEFAULT_HEIGHT = 23;

    private static final int START_LENGTH = 4;
    private static final long BASE_STEP_MS = 145;
    private static final long MIN_STEP_MS = 68;
    private static final long STEP_DECREASE_MS = 4;
    private static final int MAX_QUEUED_TURNS = 3;
    private static final int LEVEL_SIZE = 5;

    public enum Direction {
        UP(0, -1),
        DOWN(0, 1),
        LEFT(-1, 0),
        RIGHT(1, 0);

        private final int dx;
        private final int dy;

        Direction(int dx, int dy) {
            this.dx = dx;
            this.dy = dy;
        }

        boolean isOpposite(Direction other) {
            return dx + other.dx == 0 && dy + other.dy == 0;
        }

        static Direction parse(String value) {
            if (value == null) {
                return null;
            }
            try {
                return Direction.valueOf(value.trim().toUpperCase());
            } catch (IllegalArgumentException exception) {
                return null;
            }
        }
    }

    public enum Status {
        READY,
        RUNNING,
        PAUSED,
        GAME_OVER
    }

    public record Cell(int x, int y) {
    }

    private final String id;
    private final int width;
    private final int height;
    private final Random random;

    private final List<Cell> snake = new ArrayList<>();
    private final Deque<Direction> queuedTurns = new ArrayDeque<>();

    private Direction direction;
    private Cell food;
    private Status status;
    private int score;
    private boolean won;
    private long nextStepAt;
    private long version;

    public Game(String id, int width, int height, Random random) {
        if (width < START_LENGTH + 2 || height < 4) {
            throw new IllegalArgumentException("Spielfeld ist zu klein");
        }
        this.id = id;
        this.width = width;
        this.height = height;
        this.random = random;
        reset(System.currentTimeMillis());
        this.status = Status.READY;
        this.nextStepAt = 0L;
    }


    public synchronized void start(long now) {
        if (status == Status.READY || status == Status.PAUSED) {
            status = Status.RUNNING;
            nextStepAt = now + stepInterval();
            version++;
        }
    }


    public synchronized void togglePause(long now) {
        switch (status) {
            case RUNNING -> {
                status = Status.PAUSED;
                version++;
            }
            case PAUSED -> {
                status = Status.RUNNING;
                nextStepAt = now + stepInterval();
                version++;
            }
            case READY -> start(now);
            default -> {
                // GAME_OVER laesst sich nicht pausieren.
            }
        }
    }


    public synchronized void restart(long now) {

        reset(now);
    }


    public synchronized boolean turn(String rawDirection) {
        Direction requested = Direction.parse(rawDirection);
        if (requested == null || status == Status.GAME_OVER) {
            return false;
        }
        Direction reference = queuedTurns.isEmpty() ? direction : queuedTurns.peekLast();
        if (requested == reference || requested.isOpposite(reference)) {
            return false;
        }
        queuedTurns.addLast(requested);
        while (queuedTurns.size() > MAX_QUEUED_TURNS) {
            queuedTurns.removeFirst();
        }
        version++;
        return true;
    }


    public synchronized void tick(long now) {
        if (status != Status.RUNNING || now < nextStepAt) {
            return;
        }
        step();
        version++;
        if (status == Status.RUNNING) {
            nextStepAt += stepInterval();
            if (nextStepAt <= now) {
                // Nach einem Stall (z. B. Laptop im Standby) nicht aufholen.
                nextStepAt = now + stepInterval();
            }
        }
    }

    public synchronized int getScore() {
        return score;
    }

    /** Erhoeht sich bei jeder Zustandsaenderung (fuer Push-Updates und Client-Reihenfolge). */
    public synchronized long version() {
        return version;
    }

    public synchronized boolean isReady() {
        return status == Status.READY;
    }

    public synchronized String toJson(int highScore) {
        StringBuilder json = new StringBuilder(512);
        json.append("{\"id\":\"").append(id).append("\"");
        json.append(",\"width\":").append(width);
        json.append(",\"height\":").append(height);
        json.append(",\"status\":\"").append(status.name()).append("\"");
        json.append(",\"version\":").append(version);
        json.append(",\"stepMs\":").append(stepInterval());
        json.append(",\"score\":").append(score);
        json.append(",\"highScore\":").append(highScore);
        json.append(",\"level\":").append(level());
        json.append(",\"won\":").append(won);
        json.append(",\"direction\":\"").append(direction.name()).append("\"");
        json.append(",\"food\":");
        if (food == null) {
            json.append("null");
        } else {
            appendCell(json, food);
        }
        json.append(",\"snake\":[");
        for (int i = 0; i < snake.size(); i++) {
            if (i > 0) {
                json.append(',');
            }
            appendCell(json, snake.get(i));
        }
        json.append("]}");
        return json.toString();
    }

    private void reset(long now) {
        snake.clear();
        queuedTurns.clear();
        direction = Direction.RIGHT;
        score = 0;
        won = false;

        int centerY = height / 2;
        int headX = Math.max(START_LENGTH - 1, Math.min(width - 1, width / 2 + 1));
        for (int i = 0; i < START_LENGTH; i++) {
            snake.add(new Cell(headX - i, centerY));
        }

        food = spawnFood();
        status = Status.RUNNING;
        nextStepAt = now + stepInterval();
        version++;
    }

    private void step() {
        Direction next = queuedTurns.pollFirst();
        if (next != null && !next.isOpposite(direction)) {
            direction = next;
        }

        Cell head = snake.get(0);
        int nx = head.x() + direction.dx;
        int ny = head.y() + direction.dy;

        if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
            status = Status.GAME_OVER;
            return;
        }

        Cell newHead = new Cell(nx, ny);
        boolean eating = newHead.equals(food);

        // Ohne Futter wird das Schwanzende frei, deshalb darf es betreten werden.
        int blockedUntil = eating ? snake.size() : snake.size() - 1;
        for (int i = 0; i < blockedUntil; i++) {
            if (snake.get(i).equals(newHead)) {
                status = Status.GAME_OVER;
                return;
            }
        }

        snake.add(0, newHead);

        if (eating) {
            score++;
            food = spawnFood();
            if (won) {
                status = Status.GAME_OVER;
            }
        } else {
            snake.remove(snake.size() - 1);
        }
    }

    private Cell spawnFood() {
        int total = width * height;
        if (snake.size() >= total) {
            won = true;
            return null;
        }

        // Normalfall: ein paar zufaellige Zellen proben. Das alte Verfahren baute
        // bei jedem Apfel eine komplette Freizellenliste auf (O(felder * schlangenlaenge))
        // und verursachte damit gerade bei langen Schlangen sichtbare Ruckler.
        for (int attempt = 0; attempt < 48; attempt++) {
            Cell candidate = new Cell(random.nextInt(width), random.nextInt(height));
            if (!snake.contains(candidate)) {
                return candidate;
            }
        }

        // Fallback, wenn das Feld fast voll ist: einmalig mit HashSet statt
        // listenweiser Suche je Zelle.
        Set<Cell> occupied = new HashSet<>(snake);
        List<Cell> free = new ArrayList<>(total - snake.size());
        for (int y = 0; y < height; y++) {
            for (int x = 0; x < width; x++) {
                Cell candidate = new Cell(x, y);
                if (!occupied.contains(candidate)) {
                    free.add(candidate);
                }
            }
        }
        if (free.isEmpty()) {
            won = true;
            return null;
        }
        return free.get(random.nextInt(free.size()));
    }

    private long stepInterval() {
        return Math.max(MIN_STEP_MS, BASE_STEP_MS - score * STEP_DECREASE_MS);
    }

    private int level() {
        return 1 + score / LEVEL_SIZE;
    }

    private static void appendCell(StringBuilder json, Cell cell) {
        json.append('[').append(cell.x()).append(',').append(cell.y()).append(']');
    }
}

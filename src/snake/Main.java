package snake;

import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.logging.Level;
import java.util.logging.Logger;

public final class Main {

    private static final Logger LOG = Logger.getLogger(Main.class.getName());
    private static final int DEFAULT_PORT = 8080;
    private static final String API_PREFIX = "/api/games";
    private static final Map<String, String> CONTENT_TYPES = Map.of(
            "html", "text/html; charset=utf-8",
            "css", "text/css; charset=utf-8",
            "js", "text/javascript; charset=utf-8",
            "json", "application/json; charset=utf-8",
            "svg", "image/svg+xml",
            "png", "image/png",
            "ico", "image/x-icon"
    );

    private final GameService games = new GameService();
    private final Path webRoot;

    private Main(Path webRoot) {
        this.webRoot = webRoot;
    }

    public static void main(String[] args) throws IOException {
        int port = DEFAULT_PORT;
        Path webRoot = Paths.get("web").toAbsolutePath().normalize();

        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--port", "-p" -> {
                    if (i + 1 < args.length) {
                        port = Integer.parseInt(args[++i]);
                    }
                }
                case "--web" -> {
                    if (i + 1 < args.length) {
                        webRoot = Paths.get(args[++i]).toAbsolutePath().normalize();
                    }
                }
                case "--help", "-h" -> {
                    System.out.println("""
                            Snake

                            Optionen:
                              --port, -p <port>   HTTP-Port (Standard: 8080)
                              --web <verzeichnis> Verzeichnis mit index.html (Standard: web)
                            """);
                    return;
                }
                default -> {
                    System.err.println("Unbekannte Option: " + args[i]);
                }
            }
        }

        Main application = new Main(webRoot);
        HttpServer server;
        try {
            server = HttpServer.create(new InetSocketAddress(port), 0);
        } catch (IOException exception) {
            System.err.println("Port " + port + " konnte nicht geoeffnet werden (belegt?). "
                    + "Tipp: ./run.sh --port 9090");
            System.exit(1);
            return;
        }
        server.createContext("/", application::handle);
        server.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
        server.start();

        System.out.println("""
                ============================================
                  Snake - Java Web Edition
                  http://localhost:%d
                ============================================
                """.formatted(port));

        if (!Files.isDirectory(webRoot) || !Files.isRegularFile(webRoot.resolve("index.html"))) {
            LOG.warning("Web-Verzeichnis nicht gefunden: " + webRoot + " (Tipp: im Projektordner starten)");
        }

        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            server.stop(0);
            application.games.shutdown();
        }, "snake-shutdown"));
    }

    private void handle(HttpExchange exchange) {
        try {
            String path = exchange.getRequestURI().getPath();
            if (path.equals(API_PREFIX) || path.startsWith(API_PREFIX + "/")) {
                handleApi(exchange, path);
            } else {
                serveStatic(exchange, path);
            }
        } catch (IllegalArgumentException exception) {
            try {
                sendJson(exchange, 400, error("Ungueltige Anfrage"));
            } catch (IOException ignored) {
                // Antwort konnte nicht gesendet werden.
            }
        } catch (Exception exception) {
            LOG.log(Level.WARNING, "Anfrage fehlgeschlagen: " + exchange.getRequestURI(), exception);
            try {
                sendJson(exchange, 500, error("Interner Serverfehler"));
            } catch (IOException ignored) {
                // Antwort konnte nicht gesendet werden.
            }
        } finally {
            exchange.close();
        }
    }

    private void handleApi(HttpExchange exchange, String path) throws IOException {
        String method = exchange.getRequestMethod();

        if (path.equals(API_PREFIX)) {
            if (!isMethod(method, "POST")) {
                methodNotAllowed(exchange, "POST");
                return;
            }
            Game game = games.create();
            sendJson(exchange, 201, game.toJson(games.highScore()));
            return;
        }

        String rest = path.substring(API_PREFIX.length() + 1);
        String[] parts = rest.split("/", 3);
        Game game = games.find(parts[0]);
        if (game == null) {
            sendJson(exchange, 404, error("Spiel nicht gefunden"));
            return;
        }

        String action = parts.length > 1 ? parts[1] : "";
        if (action.equals("events")) {
            handleEvents(exchange, parts[0]);
            return;
        }
        long now = System.currentTimeMillis();

        switch (action) {
            case "" -> {
                if (!isMethod(method, "GET")) {
                    methodNotAllowed(exchange, "GET");
                    return;
                }
            }
            case "start" -> {
                if (!isMethod(method, "POST")) {
                    methodNotAllowed(exchange, "POST");
                    return;
                }
                game.start(now);
            }
            case "pause" -> {
                if (!isMethod(method, "POST")) {
                    methodNotAllowed(exchange, "POST");
                    return;
                }
                game.togglePause(now);
            }
            case "restart" -> {
                if (!isMethod(method, "POST")) {
                    methodNotAllowed(exchange, "POST");
                    return;
                }
                game.restart(now);
            }
            case "direction" -> {
                if (!isMethod(method, "POST")) {
                    methodNotAllowed(exchange, "POST");
                    return;
                }
                boolean accepted = game.turn(queryParam(exchange.getRequestURI(), "dir"));
                if (accepted && game.isReady()) {
                    game.start(now);
                }
            }
            default -> {
                sendJson(exchange, 404, error("Unbekannte Aktion"));
                return;
            }
        }

        sendJson(exchange, 200, game.toJson(games.highScore()));
    }

    /**
     * Server-Sent Events: der Ticker schiebt jeden neuen Spielzustand sofort
     * raus. Damit entfaellt die Poll-Verzoegerung von bisher bis zu 60 ms.
     */
    private void handleEvents(HttpExchange exchange, String gameId) throws IOException {
        if (!isMethod(exchange.getRequestMethod(), "GET")) {
            methodNotAllowed(exchange, "GET");
            return;
        }

        GameService.SnapshotStream stream = games.subscribe(gameId);
        if (stream == null) {
            sendJson(exchange, 404, error("Spiel nicht gefunden"));
            return;
        }

        try {
            Headers headers = exchange.getResponseHeaders();
            headers.set("Content-Type", "text/event-stream; charset=utf-8");
            headers.set("Cache-Control", "no-cache, no-transform");
            headers.set("Connection", "keep-alive");
            headers.set("X-Accel-Buffering", "no");
            exchange.sendResponseHeaders(200, 0); // 0 = chunked, Verbindung bleibt offen

            try (OutputStream out = exchange.getResponseBody()) {
                long lastPing = System.nanoTime();
                while (true) {
                    String snapshot;
                    try {
                        snapshot = stream.await(500L);
                    } catch (InterruptedException exception) {
                        Thread.currentThread().interrupt();
                        break;
                    }
                    if (snapshot == GameService.SnapshotStream.CLOSE) {
                        break;
                    }
                    if (snapshot == null) {
                        if (System.nanoTime() - lastPing > TimeUnit.SECONDS.toNanos(10L)) {
                            out.write(": ping\n\n".getBytes(StandardCharsets.UTF_8));
                            out.flush();
                            lastPing = System.nanoTime();
                        }
                        continue;
                    }
                    out.write(("data: " + snapshot + "\n\n").getBytes(StandardCharsets.UTF_8));
                    out.flush();
                    lastPing = System.nanoTime();
                }
            }
        } catch (IOException exception) {
            // Browser hat die Verbindung geschlossen – voellig normal.
        } finally {
            games.unsubscribe(stream);
        }
    }

    private void serveStatic(HttpExchange exchange, String rawPath) throws IOException {
        String method = exchange.getRequestMethod();
        if (!isMethod(method, "GET") && !isMethod(method, "HEAD")) {
            methodNotAllowed(exchange, "GET, HEAD");
            return;
        }

        String relative = rawPath.equals("/") ? "index.html" : rawPath.substring(1);
        Path file = webRoot.resolve(relative).normalize();
        if (!file.startsWith(webRoot) || !Files.isRegularFile(file)) {
            sendText(exchange, 404, "Nicht gefunden");
            return;
        }

        byte[] body = Files.readAllBytes(file);
        String contentType = CONTENT_TYPES.getOrDefault(extensionOf(file), "application/octet-stream");
        Headers headers = exchange.getResponseHeaders();
        headers.set("Content-Type", contentType);
        headers.set("Cache-Control", "no-store");
        headers.set("X-Content-Type-Options", "nosniff");

        if (isMethod(method, "HEAD")) {
            exchange.sendResponseHeaders(200, -1L);
            return;
        }

        exchange.sendResponseHeaders(200, body.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(body);
        }
    }

    private static void sendJson(HttpExchange exchange, int status, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        Headers headers = exchange.getResponseHeaders();
        headers.set("Content-Type", "application/json; charset=utf-8");
        headers.set("Cache-Control", "no-store");
        headers.set("X-Content-Type-Options", "nosniff");
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(bytes);
        }
    }

    private static void sendText(HttpExchange exchange, int status, String message) throws IOException {
        byte[] bytes = message.getBytes(StandardCharsets.UTF_8);
        Headers headers = exchange.getResponseHeaders();
        headers.set("Content-Type", "text/plain; charset=utf-8");
        headers.set("Cache-Control", "no-store");
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(bytes);
        }
    }

    private static void methodNotAllowed(HttpExchange exchange, String allowed) throws IOException {
        exchange.getResponseHeaders().set("Allow", allowed);
        sendJson(exchange, 405, error("Methode nicht erlaubt"));
    }

    private static boolean isMethod(String actual, String expected) {
        return expected.equals(actual);
    }

    private static String queryParam(URI uri, String name) {
        String query = uri.getRawQuery();
        if (query == null || query.isEmpty()) {
            return null;
        }
        for (String pair : query.split("&")) {
            int separator = pair.indexOf('=');
            String key = separator >= 0 ? pair.substring(0, separator) : pair;
            if (key.equals(name)) {
                String value = separator >= 0 ? pair.substring(separator + 1) : "";
                return URLDecoder.decode(value, StandardCharsets.UTF_8);
            }
        }
        return null;
    }

    private static String extensionOf(Path file) {
        String name = file.getFileName().toString().toLowerCase(Locale.ROOT);
        int dot = name.lastIndexOf('.');
        return dot < 0 ? "" : name.substring(dot + 1);
    }

    private static String error(String message) {
        return "{\"error\":\"" + message.replace("\\", "\\\\").replace("\"", "\\\"") + "\"}";
    }
}

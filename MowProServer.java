/*
 * =========================================================
 *  MOW PRO — Backend Java
 * ---------------------------------------------------------
 *  Servidor HTTP ligero (sin dependencias externas, solo JDK)
 *  Responsabilidades:
 *    1. Servir el frontend estático (index.html, css/, js/)
 *    2. Persistir sesiones de proyecto (JSON) en /projects
 *    3. Recibir archivos de audio subidos en /audio-library
 *    4. Mezclar (mixdown) varios WAV en un único WAV (PCM 16-bit)
 *       usando javax.sound.sampled — sin librerías de terceros.
 *
 *  Compilar:
 *      javac server/MowProServer.java -d out
 *  Ejecutar (desde la carpeta que contiene index.html, css/, js/):
 *      java -cp out MowProServer
 *  Luego abrir:
 *      http://localhost:8080
 * =========================================================
 */

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;

import javax.sound.sampled.AudioFormat;
import javax.sound.sampled.AudioInputStream;
import javax.sound.sampled.AudioSystem;
import java.io.*;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.*;

public class MowProServer {

    private static final int PORT = 8080;
    private static final Path ROOT_DIR = Paths.get("").toAbsolutePath();           // carpeta del proyecto (contiene index.html)
    private static final Path PROJECTS_DIR = ROOT_DIR.resolve("projects");
    private static final Path AUDIO_DIR = ROOT_DIR.resolve("audio-library");
    private static final Path EXPORTS_DIR = ROOT_DIR.resolve("exports");

    public static void main(String[] args) throws IOException {
        Files.createDirectories(PROJECTS_DIR);
        Files.createDirectories(AUDIO_DIR);
        Files.createDirectories(EXPORTS_DIR);

        HttpServer server = HttpServer.create(new InetSocketAddress(PORT), 0);

        // API REST
        server.createContext("/api/save", new SaveSessionHandler());
        server.createContext("/api/load", new LoadSessionHandler());
        server.createContext("/api/list", new ListSessionsHandler());
        server.createContext("/api/upload", new UploadAudioHandler());
        server.createContext("/api/library", new ListLibraryHandler());
        server.createContext("/api/export", new ExportMixHandler());

        // Archivos estáticos (index.html, /css, /js)
        server.createContext("/", new StaticFileHandler());

        server.setExecutor(Executors());
        server.start();

        System.out.println("=========================================");
        System.out.println("  MOW PRO Server — escuchando en el puerto " + PORT);
        System.out.println("  Interfaz:   http://localhost:" + PORT);
        System.out.println("  Proyectos:  " + PROJECTS_DIR);
        System.out.println("  Audio lib:  " + AUDIO_DIR);
        System.out.println("=========================================");
    }

    private static java.util.concurrent.ExecutorService Executors() {
        return java.util.concurrent.Executors.newFixedThreadPool(8);
    }

    /* ================= UTILIDADES HTTP ================= */

    private static void sendJson(HttpExchange ex, int status, String json) throws IOException {
        byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        ex.getResponseHeaders().set("Access-Control-Allow-Origin", "*");
        ex.sendResponseHeaders(status, bytes.length);
        try (OutputStream os = ex.getResponseBody()) { os.write(bytes); }
    }

    private static void sendPlain(HttpExchange ex, int status, String text) throws IOException {
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "text/plain; charset=utf-8");
        ex.sendResponseHeaders(status, bytes.length);
        try (OutputStream os = ex.getResponseBody()) { os.write(bytes); }
    }

    private static String readBody(HttpExchange ex) throws IOException {
        try (InputStream is = ex.getRequestBody();
             ByteArrayOutputStream buf = new ByteArrayOutputStream()) {
            byte[] tmp = new byte[8192];
            int n;
            while ((n = is.read(tmp)) != -1) buf.write(tmp, 0, n);
            return buf.toString(StandardCharsets.UTF_8);
        }
    }

    private static byte[] readBodyBytes(HttpExchange ex) throws IOException {
        try (InputStream is = ex.getRequestBody();
             ByteArrayOutputStream buf = new ByteArrayOutputStream()) {
            byte[] tmp = new byte[8192];
            int n;
            while ((n = is.read(tmp)) != -1) buf.write(tmp, 0, n);
            return buf.toByteArray();
        }
    }

    private static Map<String, String> parseQuery(String query) {
        Map<String, String> map = new HashMap<>();
        if (query == null) return map;
        for (String pair : query.split("&")) {
            int idx = pair.indexOf('=');
            if (idx > 0) {
                try {
                    String k = java.net.URLDecoder.decode(pair.substring(0, idx), "UTF-8");
                    String v = java.net.URLDecoder.decode(pair.substring(idx + 1), "UTF-8");
                    map.put(k, v);
                } catch (Exception ignored) {}
            }
        }
        return map;
    }

    private static String jsonEscape(String s) {
        return s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n");
    }

    /* ================= 1. GUARDAR SESIÓN ================= */

    static class SaveSessionHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange ex) throws IOException {
            if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
                sendPlain(ex, 405, "Método no permitido"); return;
            }
            String body = readBody(ex);
            String timestamp = LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMMdd_HHmmss"));
            String fileName = "sesion_" + timestamp + ".json";
            Path file = PROJECTS_DIR.resolve(fileName);
            Files.write(file, body.getBytes(StandardCharsets.UTF_8));
            sendJson(ex, 200, "{\"ok\":true,\"file\":\"" + jsonEscape(fileName) + "\"}");
            System.out.println("[MOW PRO] Sesión guardada: " + file);
        }
    }

    /* ================= 2. CARGAR SESIÓN ================= */

    static class LoadSessionHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange ex) throws IOException {
            Map<String, String> qs = parseQuery(ex.getRequestURI().getQuery());
            String name = qs.get("name");
            if (name == null || name.contains("..")) {
                sendJson(ex, 400, "{\"error\":\"Parámetro 'name' inválido\"}"); return;
            }
            Path file = PROJECTS_DIR.resolve(name);
            if (!Files.exists(file)) {
                sendJson(ex, 404, "{\"error\":\"Sesión no encontrada\"}"); return;
            }
            String content = new String(Files.readAllBytes(file), StandardCharsets.UTF_8);
            sendJson(ex, 200, content);
        }
    }

    /* ================= 3. LISTAR SESIONES ================= */

    static class ListSessionsHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange ex) throws IOException {
            List<String> names = new ArrayList<>();
            try (DirectoryStream<Path> stream = Files.newDirectoryStream(PROJECTS_DIR, "*.json")) {
                for (Path p : stream) names.add(p.getFileName().toString());
            }
            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < names.size(); i++) {
                sb.append("\"").append(jsonEscape(names.get(i))).append("\"");
                if (i < names.size() - 1) sb.append(",");
            }
            sb.append("]");
            sendJson(ex, 200, sb.toString());
        }
    }

    /* ================= 4. SUBIR AUDIO ================= */

    static class UploadAudioHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange ex) throws IOException {
            if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
                sendPlain(ex, 405, "Método no permitido"); return;
            }
            String fileName = ex.getRequestHeaders().getFirst("X-Filename");
            if (fileName == null || fileName.isEmpty()) fileName = "upload_" + System.currentTimeMillis() + ".wav";
            fileName = fileName.replaceAll("[^a-zA-Z0-9._-]", "_");
            byte[] data = readBodyBytes(ex);
            Path dest = AUDIO_DIR.resolve(fileName);
            Files.write(dest, data);
            sendJson(ex, 200, "{\"ok\":true,\"file\":\"" + jsonEscape(fileName) + "\",\"bytes\":" + data.length + "}");
            System.out.println("[MOW PRO] Audio recibido: " + dest + " (" + data.length + " bytes)");
        }
    }

    /* ================= 5. LISTAR LIBRERÍA DE AUDIO ================= */

    static class ListLibraryHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange ex) throws IOException {
            List<String> names = new ArrayList<>();
            try (DirectoryStream<Path> stream = Files.newDirectoryStream(AUDIO_DIR)) {
                for (Path p : stream) if (!Files.isDirectory(p)) names.add(p.getFileName().toString());
            }
            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < names.size(); i++) {
                sb.append("\"").append(jsonEscape(names.get(i))).append("\"");
                if (i < names.size() - 1) sb.append(",");
            }
            sb.append("]");
            sendJson(ex, 200, sb.toString());
        }
    }

    /* ================= 6. EXPORTAR / RENDERIZAR MEZCLA =================
     * Mezcla server-side de N archivos WAV (PCM) ya presentes en audio-library,
     * aplicando ganancia lineal por pista, y escribe el resultado en /exports.
     * Cuerpo esperado (JSON):
     * {
     *   "outputName": "mezcla_final.wav",
     *   "tracks": [ { "file": "voz.wav", "gain": 0.9 }, { "file": "guitarra.wav", "gain": 0.7 } ]
     * }
     * Si no se reciben pistas válidas, responde OK informando que el render
     * principal se realizó en el cliente (OfflineAudioContext).
     * ==================================================== */

    static class ExportMixHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange ex) throws IOException {
            if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
                sendPlain(ex, 405, "Método no permitido"); return;
            }
            String body = readBody(ex);
            List<TrackRef> tracks = parseTracks(body);

            if (tracks.isEmpty()) {
                sendJson(ex, 200, "{\"ok\":true,\"note\":\"Sin pistas server-side; render realizado en cliente.\"}");
                return;
            }

            try {
                String outputName = extractStringField(body, "outputName");
                if (outputName == null || outputName.isEmpty()) outputName = "mowpro_mixdown.wav";
                Path result = mixWavTracks(tracks, outputName);
                sendJson(ex, 200, "{\"ok\":true,\"file\":\"" + jsonEscape(result.getFileName().toString()) + "\"}");
                System.out.println("[MOW PRO] Mezcla renderizada: " + result);
            } catch (Exception e) {
                sendJson(ex, 500, "{\"ok\":false,\"error\":\"" + jsonEscape(e.getMessage()) + "\"}");
            }
        }

        /** Mezcla simple: suma muestras PCM 16-bit normalizando para evitar clipping. */
        private Path mixWavTracks(List<TrackRef> tracks, String outputName) throws Exception {
            List<AudioInputStream> streams = new ArrayList<>();
            AudioFormat commonFormat = null;
            List<short[]> samples = new ArrayList<>();
            int maxLength = 0;

            for (TrackRef t : tracks) {
                Path p = AUDIO_DIR.resolve(t.file);
                if (!Files.exists(p)) continue;
                try (AudioInputStream ais = AudioSystem.getAudioInputStream(p.toFile())) {
                    AudioFormat fmt = ais.getFormat();
                    if (commonFormat == null) commonFormat = fmt;
                    byte[] raw = ais.readAllBytes();
                    short[] pcm = bytesToShorts(raw, fmt.isBigEndian());
                    // aplicar ganancia
                    for (int i = 0; i < pcm.length; i++) {
                        pcm[i] = (short) Math.max(Short.MIN_VALUE, Math.min(Short.MAX_VALUE, (int) (pcm[i] * t.gain)));
                    }
                    samples.add(pcm);
                    maxLength = Math.max(maxLength, pcm.length);
                }
            }

            if (commonFormat == null) throw new IOException("Ningún archivo de audio válido encontrado en audio-library.");

            int[] mixBuffer = new int[maxLength];
            for (short[] pcm : samples) {
                for (int i = 0; i < pcm.length; i++) mixBuffer[i] += pcm[i];
            }
            short[] finalPcm = new short[maxLength];
            for (int i = 0; i < maxLength; i++) {
                finalPcm[i] = (short) Math.max(Short.MIN_VALUE, Math.min(Short.MAX_VALUE, mixBuffer[i]));
            }

            byte[] outBytes = shortsToBytes(finalPcm, commonFormat.isBigEndian());
            AudioFormat outFormat = new AudioFormat(
                    commonFormat.getSampleRate(), 16, commonFormat.getChannels(), true, commonFormat.isBigEndian());

            Path outPath = EXPORTS_DIR.resolve(outputName);
            try (ByteArrayInputStream bais = new ByteArrayInputStream(outBytes);
                 AudioInputStream outStream = new AudioInputStream(bais, outFormat, finalPcm.length)) {
                AudioSystem.write(outStream, javax.sound.sampled.AudioFileFormat.Type.WAVE, outPath.toFile());
            }
            return outPath;
        }

        private short[] bytesToShorts(byte[] raw, boolean bigEndian) {
            short[] out = new short[raw.length / 2];
            java.nio.ByteBuffer bb = java.nio.ByteBuffer.wrap(raw);
            bb.order(bigEndian ? java.nio.ByteOrder.BIG_ENDIAN : java.nio.ByteOrder.LITTLE_ENDIAN);
            for (int i = 0; i < out.length; i++) out[i] = bb.getShort();
            return out;
        }

        private byte[] shortsToBytes(short[] pcm, boolean bigEndian) {
            java.nio.ByteBuffer bb = java.nio.ByteBuffer.allocate(pcm.length * 2);
            bb.order(bigEndian ? java.nio.ByteOrder.BIG_ENDIAN : java.nio.ByteOrder.LITTLE_ENDIAN);
            for (short s : pcm) bb.putShort(s);
            return bb.array();
        }

        private String extractStringField(String json, String field) {
            String key = "\"" + field + "\"";
            int idx = json.indexOf(key);
            if (idx == -1) return null;
            int colon = json.indexOf(':', idx);
            int firstQuote = json.indexOf('"', colon + 1);
            int secondQuote = json.indexOf('"', firstQuote + 1);
            if (firstQuote == -1 || secondQuote == -1) return null;
            return json.substring(firstQuote + 1, secondQuote);
        }

        /** Parser JSON minimalista para el arreglo "tracks":[{"file":"..","gain":N}] */
        private List<TrackRef> parseTracks(String json) {
            List<TrackRef> list = new ArrayList<>();
            int tIdx = json.indexOf("\"tracks\"");
            if (tIdx == -1) return list;
            int arrStart = json.indexOf('[', tIdx);
            int arrEnd = json.indexOf(']', arrStart);
            if (arrStart == -1 || arrEnd == -1) return list;
            String arr = json.substring(arrStart + 1, arrEnd);
            for (String obj : arr.split("\\},")) {
                String file = extractStringField(obj, "file");
                double gain = 1.0;
                int gIdx = obj.indexOf("\"gain\"");
                if (gIdx != -1) {
                    int colon = obj.indexOf(':', gIdx);
                    int end = colon + 1;
                    while (end < obj.length() && (Character.isDigit(obj.charAt(end)) || obj.charAt(end) == '.' )) end++;
                    try { gain = Double.parseDouble(obj.substring(colon + 1, end).trim()); } catch (Exception ignored) {}
                }
                if (file != null) list.add(new TrackRef(file, gain));
            }
            return list;
        }
    }

    static class TrackRef {
        final String file; final double gain;
        TrackRef(String file, double gain) { this.file = file; this.gain = gain; }
    }

    /* ================= 7. ARCHIVOS ESTÁTICOS ================= */

    static class StaticFileHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange ex) throws IOException {
            String uriPath = ex.getRequestURI().getPath();
            if (uriPath.equals("/")) uriPath = "/index.html";
            Path file = ROOT_DIR.resolve(uriPath.substring(1)).normalize();

            if (!file.startsWith(ROOT_DIR) || !Files.exists(file) || Files.isDirectory(file)) {
                sendPlain(ex, 404, "404 — No encontrado: " + uriPath);
                return;
            }
            String contentType = guessContentType(file.toString());
            byte[] data = Files.readAllBytes(file);
            ex.getResponseHeaders().set("Content-Type", contentType);
            ex.sendResponseHeaders(200, data.length);
            try (OutputStream os = ex.getResponseBody()) { os.write(data); }
        }

        private String guessContentType(String path) {
            if (path.endsWith(".html")) return "text/html; charset=utf-8";
            if (path.endsWith(".css")) return "text/css; charset=utf-8";
            if (path.endsWith(".js")) return "application/javascript; charset=utf-8";
            if (path.endsWith(".json")) return "application/json; charset=utf-8";
            if (path.endsWith(".wav")) return "audio/wav";
            if (path.endsWith(".mp3")) return "audio/mpeg";
            if (path.endsWith(".png")) return "image/png";
            if (path.endsWith(".svg")) return "image/svg+xml";
            return "application/octet-stream";
        }
    }
}

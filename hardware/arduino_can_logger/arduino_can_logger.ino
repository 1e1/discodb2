#include <CAN.h>
#include <ctype.h>
#include <string.h>

// Simple CAN logger with a serial control channel.
// The host software sets the desired bitrate and can request OBD frames.

static const unsigned long kSerialBaud = 115200;
static unsigned long currentBitrate = 500000;
static bool canReady = false;

static char inputBuffer[64];
static size_t inputLen = 0;

void setup() {
  Serial.begin(kSerialBaud);
  while (!Serial) {
    delay(10);
  }

  initCan(currentBitrate);

  Serial.println("CAN logger ready.");
  Serial.println("Commands: BITRATE <bps>, OBD <service> <pid>, HELP");
}

void loop() {
  handleSerial();

  int packetSize = CAN.parsePacket();
  if (!packetSize) {
    return;
  }

  Serial.print("ID 0x");
  Serial.print(CAN.packetId(), HEX);
  Serial.print(" DLC ");
  Serial.print(packetSize);
  Serial.print(" Data ");

  while (CAN.available()) {
    int byteValue = CAN.read();
    if (byteValue < 0x10) {
      Serial.print('0');
    }
    Serial.print(byteValue, HEX);
    Serial.print(' ');
  }
  Serial.println();
}

void handleSerial() {
  while (Serial.available()) {
    char c = static_cast<char>(Serial.read());
    if (c == '\n' || c == '\r') {
      if (inputLen > 0) {
        inputBuffer[inputLen] = '\0';
        processCommand(inputBuffer);
        inputLen = 0;
      }
      continue;
    }
    if (inputLen < sizeof(inputBuffer) - 1) {
      inputBuffer[inputLen++] = c;
    }
  }
}

void processCommand(char *line) {
  while (*line == ' ') {
    line++;
  }
  if (*line == '\0') {
    return;
  }

  char *command = strtok(line, " ");
  if (!command) {
    return;
  }
  toUpper(command);

  if (strcmp(command, "BITRATE") == 0) {
    char *rateToken = strtok(NULL, " ");
    if (!rateToken) {
      Serial.println("ERR bitrate missing.");
      return;
    }
    unsigned long rate = strtoul(rateToken, NULL, 10);
    if (rate == 0) {
      Serial.println("ERR invalid bitrate.");
      return;
    }
    initCan(rate);
    return;
  }

  if (strcmp(command, "OBD") == 0) {
    char *serviceToken = strtok(NULL, " ");
    char *pidToken = strtok(NULL, " ");
    uint8_t service = 0;
    uint8_t pid = 0;

    if (!serviceToken) {
      Serial.println("ERR OBD needs service and pid.");
      return;
    }

    if (!pidToken && strlen(serviceToken) == 4) {
      if (!parseHexByte(serviceToken, &service) ||
          !parseHexByte(serviceToken + 2, &pid)) {
        Serial.println("ERR invalid OBD hex.");
        return;
      }
    } else {
      if (!parseHexByte(serviceToken, &service) || !parseHexByte(pidToken, &pid)) {
        Serial.println("ERR invalid OBD hex.");
        return;
      }
    }

    sendObdRequest(service, pid);
    return;
  }

  if (strcmp(command, "HELP") == 0) {
    Serial.println("Commands: BITRATE <bps>, OBD <service> <pid>, HELP");
    return;
  }

  Serial.println("ERR unknown command.");
}

void initCan(unsigned long bitrate) {
  CAN.end();
  delay(10);
  if (!CAN.begin(bitrate)) {
    canReady = false;
    Serial.println("CAN init failed.");
    return;
  }
  canReady = true;
  currentBitrate = bitrate;
  Serial.print("CAN ready at ");
  Serial.print(currentBitrate);
  Serial.println(" bps.");
}

void sendObdRequest(uint8_t service, uint8_t pid) {
  if (!canReady) {
    Serial.println("ERR CAN not ready.");
    return;
  }
  uint8_t payload[8] = {2, service, pid, 0, 0, 0, 0, 0};
  CAN.beginPacket(0x7DF);
  for (int i = 0; i < 8; i++) {
    CAN.write(payload[i]);
  }
  CAN.endPacket();
  Serial.print("OBD sent ");
  Serial.print(service, HEX);
  Serial.print(' ');
  Serial.println(pid, HEX);
}

bool parseHexByte(const char *text, uint8_t *value) {
  if (!text || !value) {
    return false;
  }
  if (text[0] == '0' && (text[1] == 'x' || text[1] == 'X')) {
    text += 2;
  }
  if (!isxdigit(text[0]) || !isxdigit(text[1])) {
    return false;
  }
  char buffer[3];
  buffer[0] = text[0];
  buffer[1] = text[1];
  buffer[2] = '\0';
  *value = static_cast<uint8_t>(strtoul(buffer, NULL, 16));
  return true;
}

void toUpper(char *text) {
  while (text && *text) {
    *text = static_cast<char>(toupper(*text));
    text++;
  }
}


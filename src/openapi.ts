/**
 * Hand-authored OpenAPI 3.0 spec. Kept in one file — big but readable and
 * easy to grep. A future sprint can swap this for zod-to-openapi to make it
 * the single source of truth with the validation layer.
 *
 * Covers every route mounted in server.ts. When you add a new endpoint, add
 * it here too — Definition of Done (TZ §28.3) requires Swagger to be updated.
 */

const Error = {
  $ref: '#/components/schemas/Error',
} as const;

const jsonError = { 'application/json': { schema: Error } };
const errorResponses = {
  '400': { description: 'Validation', content: jsonError },
  '401': { description: 'Unauthorized', content: jsonError },
  '403': { description: 'Forbidden', content: jsonError },
  '404': { description: 'Not found', content: jsonError },
  '409': { description: 'Conflict', content: jsonError },
  '429': { description: 'Rate limited', content: jsonError },
  '500': { description: 'Internal', content: jsonError },
} as const;

const jsonOk = (ref: string): Record<string, unknown> => ({
  'application/json': { schema: { $ref: `#/components/schemas/${ref}` } },
});

const cursorPaginated = (itemRef: string): Record<string, unknown> => ({
  type: 'object',
  properties: {
    data: { type: 'array', items: { $ref: `#/components/schemas/${itemRef}` } },
    nextCursor: { type: 'string', format: 'uuid', nullable: true },
  },
});

export const openapiDocument = {
  openapi: '3.0.3',
  info: {
    title: 'Terme API',
    version: '1.0.0',
    description:
      'Kyrgyzstan intercity carpooling platform. All endpoints under /v1. Bearer JWT where marked. TZ v2.0.',
  },
  servers: [{ url: '/v1', description: 'v1' }],
  tags: [
    { name: 'Auth' },
    { name: 'Users' },
    { name: 'Cities' },
    { name: 'Drivers' },
    { name: 'Trips' },
    { name: 'Bookings' },
    { name: 'Chat' },
    { name: 'Ratings' },
    { name: 'Notifications' },
    { name: 'Complaints' },
    { name: 'Admin' },
    { name: 'Health' },
  ],
  components: {
    securitySchemes: {
      BearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    schemas: {
      // ─── Error envelope ───────────────────────────────────────────
      Error: {
        type: 'object',
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message', 'request_id'],
            properties: {
              code: {
                type: 'string',
                enum: [
                  'VALIDATION_ERROR',
                  'UNAUTHORIZED',
                  'TOKEN_EXPIRED',
                  'FORBIDDEN',
                  'NOT_FOUND',
                  'CONFLICT',
                  'SEATS_NOT_AVAILABLE',
                  'BOOKING_ALREADY_EXISTS',
                  'TRIP_NOT_ACTIVE',
                  'RATE_LIMITED',
                  'OTP_EXPIRED',
                  'OTP_WRONG',
                  'OTP_TOO_MANY_ATTEMPTS',
                  'INTERNAL_ERROR',
                  'SERVICE_UNAVAILABLE',
                ],
              },
              message: { type: 'string' },
              message_kg: { type: 'string' },
              details: { type: 'object', additionalProperties: true },
              request_id: { type: 'string', format: 'uuid' },
            },
          },
        },
      },

      // ─── Tokens & user ────────────────────────────────────────────
      TokenPair: {
        type: 'object',
        properties: {
          accessToken: { type: 'string' },
          refreshToken: { type: 'string' },
          accessTokenExpiresIn: { type: 'integer' },
          refreshTokenExpiresIn: { type: 'integer' },
        },
      },
      AuthResult: {
        allOf: [
          { $ref: '#/components/schemas/TokenPair' },
          {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['full'] },
              user: {
                type: 'object',
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  phone: { type: 'string' },
                  name: { type: 'string' },
                  roles: { type: 'array', items: { type: 'string' } },
                  language: { type: 'string', enum: ['ru', 'kg'] },
                  phoneVerified: { type: 'boolean' },
                  telegramLinked: { type: 'boolean' },
                  providers: {
                    type: 'array',
                    items: { type: 'string', enum: ['telegram', 'google', 'apple', 'phone'] },
                  },
                  termsAcceptedAt: { type: 'string', format: 'date-time', nullable: true },
                },
              },
            },
          },
        ],
      },
      // v2.1 §8.2 — issued by /auth/telegram|google|apple when phone isn't
      // bound yet; unlocks only /auth/phone/send-otp + /auth/phone/verify.
      ProvisionalAuthResult: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['provisional'] },
          provisionalToken: { type: 'string' },
          provisionalTokenExpiresIn: { type: 'integer' },
          requiresPhoneVerification: { type: 'boolean', enum: [true] },
          hintPhone: { type: 'string', nullable: true },
          hintName: { type: 'string', nullable: true },
          user: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              provider: { type: 'string', enum: ['telegram', 'google', 'apple', 'phone'] },
            },
          },
        },
      },
      AnyAuthResult: {
        oneOf: [
          { $ref: '#/components/schemas/AuthResult' },
          { $ref: '#/components/schemas/ProvisionalAuthResult' },
        ],
        discriminator: { propertyName: 'kind' },
      },
      PublicUser: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          avatarUrl: { type: 'string', nullable: true },
          roles: { type: 'array', items: { type: 'string' } },
          rating: { type: 'number', nullable: true },
          ratingCount: { type: 'integer' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      SelfUser: {
        allOf: [
          { $ref: '#/components/schemas/PublicUser' },
          {
            type: 'object',
            properties: {
              phone: { type: 'string' },
              phoneVerified: { type: 'boolean' },
              telegramLinked: { type: 'boolean' },
              language: { type: 'string', enum: ['ru', 'kg'] },
              bio: { type: 'string', nullable: true, maxLength: 300 },
              loyaltyPoints: { type: 'integer' },
              termsAcceptedAt: { type: 'string', format: 'date-time', nullable: true },
              lastSeenAt: { type: 'string', format: 'date-time', nullable: true },
            },
          },
        ],
      },

      // ─── Cities ───────────────────────────────────────────────────
      City: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          nameRu: { type: 'string' },
          nameKg: { type: 'string' },
          region: { type: 'string', nullable: true },
          lat: { type: 'number', nullable: true },
          lng: { type: 'number', nullable: true },
        },
      },

      // ─── Driver ───────────────────────────────────────────────────
      DriverStatus: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['none', 'pending', 'verified', 'rejected', 'docs_requested', 'suspended', 'blocked'],
          },
          submittedAt: { type: 'string', format: 'date-time', nullable: true },
          verifiedAt: { type: 'string', format: 'date-time', nullable: true },
          rejectionReason: { type: 'string', nullable: true },
          requestedDocs: { type: 'array', items: { type: 'string' } },
          car: {
            type: 'object',
            nullable: true,
            properties: {
              make: { type: 'string' },
              model: { type: 'string' },
              year: { type: 'integer' },
              color: { type: 'string' },
              plate: { type: 'string' },
              seats: { type: 'integer' },
            },
          },
        },
      },

      // ─── Trip ─────────────────────────────────────────────────────
      // Lean card DTO returned by GET /trips (search/browse). Full trip data is
      // served by GET /trips/{id} (TripDetail), fetched when a card is opened.
      TripCardItem: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          driverId: { type: 'string', format: 'uuid' },
          driver: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              name: { type: 'string' },
              avatarUrl: { type: 'string', nullable: true },
              rating: { type: 'number', nullable: true },
              ratingCount: { type: 'integer' },
              verified: { type: 'boolean' },
              car: {
                type: 'object',
                nullable: true,
                properties: {
                  make: { type: 'string' },
                  model: { type: 'string' },
                },
              },
            },
          },
          originCity: { type: 'string' },
          destinationCity: { type: 'string' },
          pickupCities: { type: 'array', items: { type: 'string' } },
          departureAt: { type: 'string', format: 'date-time' },
          departureWindowEnd: { type: 'string', format: 'date-time', nullable: true },
          seatsAvailable: { type: 'integer' },
          pricePerSeat: { type: 'integer' },
          status: { type: 'string', enum: ['active', 'completed', 'cancelled'] },
          liked: { type: 'boolean', description: 'Whether the requesting viewer liked this listing' },
        },
      },
      TripListItem: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          driverId: { type: 'string', format: 'uuid' },
          driver: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              name: { type: 'string' },
              avatarUrl: { type: 'string', nullable: true },
              rating: { type: 'number', nullable: true },
              ratingCount: { type: 'integer' },
              verified: { type: 'boolean' },
              car: {
                type: 'object',
                nullable: true,
                properties: {
                  make: { type: 'string' },
                  model: { type: 'string' },
                  color: { type: 'string' },
                  plate: { type: 'string' },
                },
              },
            },
          },
          originCity: { type: 'string' },
          destinationCity: { type: 'string' },
          originAddress: { type: 'string' },
          departureAt: { type: 'string', format: 'date-time' },
          departureFlexible: { type: 'boolean' },
          estimatedDurationMin: { type: 'integer' },
          seatsTotal: { type: 'integer' },
          seatsAvailable: { type: 'integer' },
          pricePerSeat: { type: 'integer' },
          priceNegotiable: { type: 'boolean' },
          luggage: { type: 'string', enum: ['yes', 'small', 'no'] },
          status: { type: 'string', enum: ['active', 'completed', 'cancelled'] },
          createdAt: { type: 'string', format: 'date-time' },
          liked: { type: 'boolean', description: 'Whether the requesting viewer liked this listing' },
          myResponse: {
            type: 'object',
            nullable: true,
            description: 'The viewing driver’s own response to this request, if any',
            properties: { id: { type: 'string' }, status: { type: 'string' } },
          },
          metrics: {
            type: 'object',
            nullable: true,
            description: 'Engagement stats — present only when the viewer is the creator',
            properties: { views: { type: 'integer' }, likes: { type: 'integer' } },
          },
        },
      },
      TripDetail: {
        allOf: [
          { $ref: '#/components/schemas/TripListItem' },
          {
            type: 'object',
            properties: {
              comment: { type: 'string', nullable: true },
              myBooking: {
                type: 'object',
                nullable: true,
                properties: { id: { type: 'string' }, status: { type: 'string' } },
              },
              preferences: { type: 'object', additionalProperties: { type: 'boolean' } },
              waypoints: { type: 'array', items: { type: 'object' } },
              recentRatings: { type: 'array', items: { type: 'object' } },
            },
          },
        ],
      },

      // ─── Booking ──────────────────────────────────────────────────
      Booking: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          tripId: { type: 'string', format: 'uuid' },
          passengerId: { type: 'string', format: 'uuid' },
          seatsCount: { type: 'integer' },
          status: {
            type: 'string',
            enum: [
              'pending',
              'accepted',
              'rejected',
              'cancelled_by_passenger',
              'cancelled_by_driver',
              'cancelled_late',
              'no_show',
              'completed',
              'expired',
            ],
          },
          comment: { type: 'string', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          expiresAt: { type: 'string', format: 'date-time', nullable: true },
          trip: { type: 'object' },
          passenger: { type: 'object' },
        },
      },

      // ─── Chat ─────────────────────────────────────────────────────
      ChatMessage: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          bookingId: { type: 'string', format: 'uuid' },
          senderId: { type: 'string', format: 'uuid' },
          text: { type: 'string' },
          isRead: { type: 'boolean' },
          readAt: { type: 'string', format: 'date-time', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },

      // ─── Rating ───────────────────────────────────────────────────
      PendingRating: {
        type: 'object',
        properties: {
          tripId: { type: 'string', format: 'uuid' },
          counterpartId: { type: 'string', format: 'uuid' },
          counterpartName: { type: 'string' },
          direction: { type: 'string', enum: ['driver', 'passenger'] },
          departureAt: { type: 'string', format: 'date-time' },
          expiresAt: { type: 'string', format: 'date-time' },
        },
      },

      // ─── Notification ────────────────────────────────────────────
      Notification: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          userId: { type: 'string', format: 'uuid' },
          type: { type: 'string' },
          channel: { type: 'string', enum: ['telegram', 'push', 'both'] },
          payload: { type: 'object' },
          delivered: { type: 'boolean' },
          readAt: { type: 'string', format: 'date-time', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },

      // ─── Complaint ───────────────────────────────────────────────
      ComplaintListItem: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          category: { type: 'string', enum: ['safety', 'fraud', 'rudeness', 'no_show', 'other'] },
          priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
          status: { type: 'string', enum: ['new', 'in_review', 'resolved', 'dismissed'] },
          description: { type: 'string' },
          attachments: { type: 'array', items: { type: 'string' } },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },

      // ─── Admin KPI ───────────────────────────────────────────────
      AdminKpi: {
        type: 'object',
        properties: {
          users: {
            type: 'object',
            properties: {
              total: { type: 'integer' },
              last_7d: { type: 'integer' },
              last_30d: { type: 'integer' },
            },
          },
          activeDrivers7d: { type: 'integer' },
          publishedTripsNow: { type: 'integer' },
          completedTrips: {
            type: 'object',
            properties: {
              last_7d: { type: 'integer' },
              last_30d: { type: 'integer' },
            },
          },
          acceptanceRate7d: { type: 'number', nullable: true },
          pendingVerifications: { type: 'integer' },
          openComplaints: { type: 'integer' },
          avgDriverRating: { type: 'number', nullable: true },
        },
      },
    },
  },
  security: [{ BearerAuth: [] }],

  // ─── Paths ─────────────────────────────────────────────────────────
  paths: {
    // Health
    '/health': {
      get: {
        tags: ['Health'],
        summary: 'Service health',
        security: [],
        responses: { '200': { description: 'Healthy' }, '503': { description: 'Degraded' } },
      },
    },

    // ─── Auth ────────────────────────────────────────────────────────
    '/auth/telegram': {
      post: {
        tags: ['Auth'],
        summary: 'Login via Telegram Mini App initData (may return provisional)',
        description:
          'Returns AuthResult when the user already has a verified phone. '
          + 'Returns ProvisionalAuthResult on first login — client must then '
          + 'call /auth/phone/send-otp + /auth/phone/verify (Bearer: provisional) to complete.',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['initData'],
                properties: { initData: { type: 'string' } },
              },
            },
          },
        },
        responses: {
          '200': { description: 'OK', content: jsonOk('AnyAuthResult') },
          ...errorResponses,
        },
      },
    },
    // ─── v2.1 OAuth providers ──────────────────────────────────────
    '/auth/google': {
      post: {
        tags: ['Auth'],
        summary: 'Login via Google id_token (may return provisional)',
        description:
          'Server verifies id_token against Google JWKS + GOOGLE_CLIENT_IDS '
          + 'audience allowlist. First-time Google users receive ProvisionalAuthResult '
          + 'until they complete SMS phone verification (§8.3 v2.1).',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['idToken'],
                properties: { idToken: { type: 'string' } },
              },
            },
          },
        },
        responses: {
          '200': { description: 'OK', content: jsonOk('AnyAuthResult') },
          ...errorResponses,
        },
      },
    },
    '/auth/apple': {
      post: {
        tags: ['Auth'],
        summary: 'Login via Apple identity_token (may return provisional)',
        description: 'Same semantics as /auth/google — server verifies via Apple JWKS.',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['identityToken'],
                properties: { identityToken: { type: 'string' } },
              },
            },
          },
        },
        responses: {
          '200': { description: 'OK', content: jsonOk('AnyAuthResult') },
          ...errorResponses,
        },
      },
    },
    '/auth/phone/login': {
      post: {
        tags: ['Auth'],
        summary: 'Repeat login: phone + password (no OTP)',
        description:
          'For users who already verified phone and set a password. '
          + 'v2.1 §8.4 — no SMS on repeat login.',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['phone', 'password'],
                properties: {
                  phone: { type: 'string', example: '+996700111222' },
                  password: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'OK', content: jsonOk('AuthResult') },
          ...errorResponses,
        },
      },
    },
    '/auth/phone/send-otp': {
      post: {
        tags: ['Auth'],
        summary: 'Send OTP to +996XXXXXXXXX',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['phone'],
                properties: { phone: { type: 'string', example: '+996700111222' } },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'OTP sent',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { expiresInSec: { type: 'integer' } } },
              },
            },
          },
          ...errorResponses,
        },
      },
    },
    '/auth/phone/verify': {
      post: {
        tags: ['Auth'],
        summary: 'Verify OTP — binds phone to provisional user if Bearer is set',
        description:
          'Two modes: (a) no Bearer → find-or-create user by phone. '
          + '(b) Bearer: provisional-token → bind this phone to the user '
          + 'that OAuth created, preserving one-account rule.',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['phone', 'code'],
                properties: {
                  phone: { type: 'string' },
                  code: { type: 'string' },
                  channel: { type: 'string', enum: ['mobile', 'web'] },
                  deviceInfo: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'OK', content: jsonOk('AuthResult') },
          ...errorResponses,
        },
      },
    },
    '/auth/refresh': {
      post: {
        tags: ['Auth'],
        summary: 'Rotate refresh token',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['refreshToken'],
                properties: {
                  refreshToken: { type: 'string' },
                  channel: { type: 'string', enum: ['mobile', 'web'] },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'OK', content: jsonOk('TokenPair') },
          ...errorResponses,
        },
      },
    },
    '/auth/logout': {
      post: {
        tags: ['Auth'],
        summary: 'Revoke refresh token',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['refreshToken'],
                properties: { refreshToken: { type: 'string' } },
              },
            },
          },
        },
        responses: { '204': { description: 'Revoked' }, ...errorResponses },
      },
    },
    '/auth/logout/all': {
      post: {
        tags: ['Auth'],
        summary: 'Revoke every refresh token for the caller (all devices)',
        responses: { '204': { description: 'All sessions revoked' }, ...errorResponses },
      },
    },
    '/auth/admin/login': {
      post: {
        tags: ['Auth'],
        summary: 'Admin login (email+password [+TOTP])',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string' },
                  totp: { type: 'string' },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'OK' }, ...errorResponses },
      },
    },

    // ─── Users ──────────────────────────────────────────────────────
    '/users/me': {
      get: {
        tags: ['Users'],
        summary: 'Self profile',
        responses: { '200': { description: 'OK', content: jsonOk('SelfUser') }, ...errorResponses },
      },
      patch: {
        tags: ['Users'],
        summary: 'Update name/language/terms',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string', minLength: 2, maxLength: 50 },
                  language: { type: 'string', enum: ['ru', 'kg'] },
                  termsAccepted: { type: 'boolean', enum: [true] },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'OK', content: jsonOk('SelfUser') }, ...errorResponses },
      },
      delete: {
        tags: ['Users'],
        summary: 'Soft delete account',
        responses: { '204': { description: 'Deleted' }, ...errorResponses },
      },
    },
    '/users/me/export': {
      get: {
        tags: ['Users'],
        summary: 'GDPR export (JSON dump)',
        responses: {
          '200': { description: 'JSON file download', content: { 'application/json': {} } },
          ...errorResponses,
        },
      },
    },
    // ─── v2.1 §8.12 account management ───────────────────────────────
    '/users/me/password': {
      patch: {
        tags: ['Users'],
        summary: 'Set password (first time) or change it (current required)',
        description:
          'Without an existing password — pass only newPassword. '
          + 'With an existing password — currentPassword is required. '
          + 'New password must be ≥8 chars and contain a digit.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['newPassword'],
                properties: {
                  currentPassword: { type: 'string' },
                  newPassword: {
                    type: 'string',
                    minLength: 8,
                    maxLength: 200,
                    description: 'must contain at least one digit',
                  },
                },
              },
            },
          },
        },
        responses: { '204': { description: 'Set' }, ...errorResponses },
      },
    },
    '/users/me/phone': {
      patch: {
        tags: ['Users'],
        summary: 'Start phone-change flow — OTP to NEW number',
        description:
          'v2.1 §8.7 — requires current-provider re-auth. Returns '
          + '{ expiresInSec: 600 }. Finish with PATCH /users/me/phone/confirm.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['newPhone', 'reAuthProof'],
                properties: {
                  newPhone: { type: 'string', example: '+996700111333' },
                  reAuthProof: {
                    oneOf: [
                      {
                        type: 'object',
                        required: ['provider', 'initData'],
                        properties: {
                          provider: { type: 'string', enum: ['telegram'] },
                          initData: { type: 'string' },
                        },
                      },
                      {
                        type: 'object',
                        required: ['provider', 'idToken'],
                        properties: {
                          provider: { type: 'string', enum: ['google'] },
                          idToken: { type: 'string' },
                        },
                      },
                      {
                        type: 'object',
                        required: ['provider', 'identityToken'],
                        properties: {
                          provider: { type: 'string', enum: ['apple'] },
                          identityToken: { type: 'string' },
                        },
                      },
                      {
                        type: 'object',
                        required: ['provider', 'password'],
                        properties: {
                          provider: { type: 'string', enum: ['phone'] },
                          password: { type: 'string' },
                        },
                      },
                    ],
                    discriminator: { propertyName: 'provider' },
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'OTP sent to new phone',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { expiresInSec: { type: 'integer', example: 600 } },
                },
              },
            },
          },
          ...errorResponses,
        },
      },
    },
    '/users/me/phone/confirm': {
      patch: {
        tags: ['Users'],
        summary: 'Complete phone change — swap phone + revoke other sessions',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['newPhone', 'code'],
                properties: {
                  newPhone: { type: 'string' },
                  code: { type: 'string', pattern: '^\\d{6}$' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Phone updated, new AuthResult returned',
            content: jsonOk('AuthResult'),
          },
          ...errorResponses,
        },
      },
    },
    '/users/me/providers': {
      post: {
        tags: ['Users'],
        summary: 'Link an additional OAuth provider to this account',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  {
                    type: 'object',
                    required: ['provider', 'initData'],
                    properties: {
                      provider: { type: 'string', enum: ['telegram'] },
                      initData: { type: 'string' },
                    },
                  },
                  {
                    type: 'object',
                    required: ['provider', 'idToken'],
                    properties: {
                      provider: { type: 'string', enum: ['google'] },
                      idToken: { type: 'string' },
                    },
                  },
                  {
                    type: 'object',
                    required: ['provider', 'identityToken'],
                    properties: {
                      provider: { type: 'string', enum: ['apple'] },
                      identityToken: { type: 'string' },
                    },
                  },
                ],
                discriminator: { propertyName: 'provider' },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Linked',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    provider: { type: 'string', enum: ['telegram', 'google', 'apple'] },
                  },
                },
              },
            },
          },
          ...errorResponses,
        },
      },
    },
    '/users/me/providers/{provider}': {
      delete: {
        tags: ['Users'],
        summary: 'Unlink a provider (rejects removing the last one)',
        parameters: [
          {
            name: 'provider',
            in: 'path',
            required: true,
            schema: { type: 'string', enum: ['telegram', 'google', 'apple', 'phone'] },
          },
        ],
        responses: { '204': { description: 'Unlinked' }, ...errorResponses },
      },
    },
    '/users/avatar': {
      post: {
        tags: ['Users'],
        summary: 'Upload avatar (multipart)',
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                properties: { avatar: { type: 'string', format: 'binary' } },
                required: ['avatar'],
              },
            },
          },
        },
        responses: { '200': { description: 'OK' }, ...errorResponses },
      },
    },
    '/users/{id}': {
      get: {
        tags: ['Users'],
        summary: 'Public profile',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'OK', content: jsonOk('PublicUser') }, ...errorResponses },
      },
    },
    '/users/{id}/ratings': {
      get: {
        tags: ['Users'],
        summary: 'Ratings received by user',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'cursor', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50 } },
        ],
        responses: { '200': { description: 'OK' }, ...errorResponses },
      },
    },

    // ─── Cities ─────────────────────────────────────────────────────
    '/cities': {
      get: {
        tags: ['Cities'],
        summary: 'Active KG cities',
        security: [],
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { data: { type: 'array', items: { $ref: '#/components/schemas/City' } } } },
              },
            },
          },
        },
      },
    },

    // ─── Drivers ────────────────────────────────────────────────────
    '/drivers/verification': {
      post: {
        tags: ['Drivers'],
        summary: 'Submit verification (4 photos + car data, multipart)',
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['carMake', 'carModel', 'carYear', 'carColor', 'carPlate', 'seatsCount', 'license', 'car_passport', 'car_photo', 'selfie'],
                properties: {
                  carMake: { type: 'string' },
                  carModel: { type: 'string' },
                  carYear: { type: 'integer' },
                  carColor: { type: 'string' },
                  carPlate: { type: 'string' },
                  seatsCount: { type: 'integer', minimum: 1, maximum: 7 },
                  license: { type: 'string', format: 'binary' },
                  car_passport: { type: 'string', format: 'binary' },
                  car_photo: { type: 'string', format: 'binary' },
                  selfie: { type: 'string', format: 'binary' },
                },
              },
            },
          },
        },
        responses: { '201': { description: 'Pending' }, ...errorResponses },
      },
    },
    '/drivers/verification/status': {
      get: {
        tags: ['Drivers'],
        summary: 'Own verification status',
        responses: { '200': { description: 'OK', content: jsonOk('DriverStatus') }, ...errorResponses },
      },
    },
    '/drivers/verification/upload': {
      post: {
        tags: ['Drivers'],
        summary: 'Re-upload specific doc after REQUEST_MORE_DOCS',
        parameters: [
          {
            name: 'category',
            in: 'query',
            required: true,
            schema: { type: 'string', enum: ['license', 'car_passport', 'car_photo', 'selfie'] },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } },
            },
          },
        },
        responses: { '200': { description: 'OK' }, ...errorResponses },
      },
    },
    '/drivers/me/stats': {
      get: {
        tags: ['Drivers'],
        summary: 'Own driver stats',
        responses: { '200': { description: 'OK' }, ...errorResponses },
      },
    },

    // ─── Trips ──────────────────────────────────────────────────────
    '/trips': {
      get: {
        tags: ['Trips'],
        summary: 'Search trips',
        parameters: [
          { name: 'from_city', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'to_city', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'date', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'seats', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 4 } },
          { name: 'min_price', in: 'query', schema: { type: 'integer' } },
          { name: 'max_price', in: 'query', schema: { type: 'integer' } },
          { name: 'only_verified', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } },
          { name: 'luggage', in: 'query', schema: { type: 'string', enum: ['yes', 'small', 'no'] } },
          { name: 'sort', in: 'query', schema: { type: 'string', enum: ['time', 'price_asc', 'rating_desc'] } },
          { name: 'cursor', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50 } },
        ],
        responses: {
          '200': {
            description: 'OK',
            content: { 'application/json': { schema: cursorPaginated('TripCardItem') } },
          },
          ...errorResponses,
        },
      },
      post: {
        tags: ['Trips'],
        summary: 'Publish trip (driver only, requires Idempotency-Key)',
        parameters: [
          { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['originCity', 'destinationCity', 'originAddress', 'departureAt', 'seatsTotal', 'pricePerSeat'],
                properties: {
                  originCity: { type: 'string' },
                  destinationCity: { type: 'string' },
                  originAddress: { type: 'string' },
                  originLat: { type: 'number' },
                  originLng: { type: 'number' },
                  waypoints: { type: 'array' },
                  departureAt: { type: 'string', format: 'date-time' },
                  departureFlexible: { type: 'boolean' },
                  seatsTotal: { type: 'integer', minimum: 1, maximum: 7 },
                  pricePerSeat: { type: 'integer', minimum: 50, maximum: 10000 },
                  priceNegotiable: { type: 'boolean' },
                  luggage: { type: 'string', enum: ['yes', 'small', 'no'] },
                  preferences: { type: 'object' },
                  comment: { type: 'string', maxLength: 300 },
                },
              },
            },
          },
        },
        responses: {
          '201': { description: 'Created', content: jsonOk('TripDetail') },
          '200': { description: 'Idempotency replay', content: jsonOk('TripDetail') },
          ...errorResponses,
        },
      },
    },
    '/trips/my': {
      get: {
        tags: ['Trips'],
        summary: 'Driver\'s trips by tab',
        parameters: [
          { name: 'tab', in: 'query', schema: { type: 'string', enum: ['active', 'in_transit', 'past', 'cancelled'] } },
          { name: 'cursor', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50 } },
        ],
        responses: { '200': { description: 'OK' }, ...errorResponses },
      },
    },
    '/trips/{id}': {
      get: {
        tags: ['Trips'],
        summary: 'Trip detail',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'OK', content: jsonOk('TripDetail') }, ...errorResponses },
      },
      patch: {
        tags: ['Trips'],
        summary: 'Update own trip (price, comment, luggage, preferences)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  pricePerSeat: { type: 'integer', minimum: 50, maximum: 10000 },
                  priceNegotiable: { type: 'boolean' },
                  comment: { type: 'string', nullable: true },
                  luggage: { type: 'string', enum: ['yes', 'small', 'no'] },
                  preferences: { type: 'object' },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'OK' }, ...errorResponses },
      },
      delete: {
        tags: ['Trips'],
        summary: 'Cancel own trip',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'Cancelled' }, ...errorResponses },
      },
    },
    '/trips/{id}/like': {
      post: {
        tags: ['Trips'],
        summary: 'Like a trip',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          '200': {
            description: 'Liked',
            content: { 'application/json': { schema: { type: 'object', properties: { liked: { type: 'boolean' } } } } },
          },
          ...errorResponses,
        },
      },
      delete: {
        tags: ['Trips'],
        summary: 'Remove a trip like',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          '200': {
            description: 'Unliked',
            content: { 'application/json': { schema: { type: 'object', properties: { liked: { type: 'boolean' } } } } },
          },
          ...errorResponses,
        },
      },
    },
    '/routes/price-suggestion': {
      get: {
        tags: ['Trips'],
        summary: 'Average price on route (last 30d)',
        parameters: [
          { name: 'from', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'to', in: 'query', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'OK' }, ...errorResponses },
      },
    },

    // ─── Bookings ───────────────────────────────────────────────────
    '/bookings': {
      post: {
        tags: ['Bookings'],
        summary: 'Request booking (SELECT FOR UPDATE)',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['tripId', 'seatsCount'],
                properties: {
                  tripId: { type: 'string', format: 'uuid' },
                  seatsCount: { type: 'integer', minimum: 1, maximum: 4 },
                  comment: { type: 'string', maxLength: 300 },
                },
              },
            },
          },
        },
        responses: { '201': { description: 'Pending', content: jsonOk('Booking') }, ...errorResponses },
      },
    },
    '/bookings/my': {
      get: {
        tags: ['Bookings'],
        summary: 'Passenger\'s bookings',
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'cursor', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50 } },
        ],
        responses: { '200': { description: 'OK' }, ...errorResponses },
      },
    },
    '/bookings/incoming': {
      get: {
        tags: ['Bookings'],
        summary: 'Driver\'s pending incoming requests',
        parameters: [
          { name: 'tripId', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'cursor', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50 } },
        ],
        responses: { '200': { description: 'OK' }, ...errorResponses },
      },
    },
    '/bookings/{id}': {
      get: {
        tags: ['Bookings'],
        summary: 'Booking detail',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'OK', content: jsonOk('Booking') }, ...errorResponses },
      },
    },
    '/bookings/{id}/accept': {
      patch: {
        tags: ['Bookings'],
        summary: 'Accept (driver, SELECT FOR UPDATE)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'OK' }, ...errorResponses },
      },
    },
    '/bookings/{id}/reject': {
      patch: {
        tags: ['Bookings'],
        summary: 'Reject (driver)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          content: {
            'application/json': {
              schema: { type: 'object', properties: { reason: { type: 'string' } } },
            },
          },
        },
        responses: { '200': { description: 'OK' }, ...errorResponses },
      },
    },
    '/bookings/{id}/cancel': {
      patch: {
        tags: ['Bookings'],
        summary: 'Cancel booking (either side; 2h rule applies to passengers)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'OK' }, ...errorResponses },
      },
    },
    '/bookings/{id}/no-show': {
      patch: {
        tags: ['Bookings'],
        summary: 'Mark no-show (driver, after departure_at)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'OK' }, ...errorResponses },
      },
    },

    // ─── Chat ───────────────────────────────────────────────────────
    '/chats/{booking_id}/messages': {
      get: {
        tags: ['Chat'],
        summary: 'Chat history (cursor)',
        parameters: [
          { name: 'booking_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'cursor', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
        ],
        responses: { '200': { description: 'OK' }, ...errorResponses },
      },
      post: {
        tags: ['Chat'],
        summary: 'Send message (REST fallback — WebSocket preferred)',
        parameters: [{ name: 'booking_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['text'],
                properties: {
                  text: { type: 'string', minLength: 1, maxLength: 2000 },
                  clientMsgId: { type: 'string' },
                },
              },
            },
          },
        },
        responses: { '201': { description: 'Sent' }, ...errorResponses },
      },
    },
    '/messages/{id}/read': {
      patch: {
        tags: ['Chat'],
        summary: 'Mark message read',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'OK', content: jsonOk('ChatMessage') }, ...errorResponses },
      },
    },

    // ─── Ratings ────────────────────────────────────────────────────
    '/ratings': {
      post: {
        tags: ['Ratings'],
        summary: 'Post a rating (completed trip, within 7 days)',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['tripId', 'rateeId', 'score'],
                properties: {
                  tripId: { type: 'string', format: 'uuid' },
                  rateeId: { type: 'string', format: 'uuid' },
                  score: { type: 'integer', minimum: 1, maximum: 5 },
                  tags: { type: 'array', items: { type: 'string' } },
                  comment: { type: 'string', maxLength: 500 },
                },
              },
            },
          },
        },
        responses: { '201': { description: 'Created' }, ...errorResponses },
      },
    },
    '/ratings/pending': {
      get: {
        tags: ['Ratings'],
        summary: 'Trips awaiting a rating from me',
        parameters: [
          { name: 'cursor', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50 } },
        ],
        responses: {
          '200': {
            description: 'OK',
            content: { 'application/json': { schema: cursorPaginated('PendingRating') } },
          },
          ...errorResponses,
        },
      },
    },

    // ─── Notifications ───────────────────────────────────────────────
    '/notifications': {
      get: {
        tags: ['Notifications'],
        summary: 'My notifications feed',
        parameters: [
          { name: 'cursor', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50 } },
          { name: 'unread', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } },
        ],
        responses: { '200': { description: 'OK' }, ...errorResponses },
      },
    },
    '/notifications/{id}/read': {
      patch: {
        tags: ['Notifications'],
        summary: 'Mark notification read',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'OK' }, ...errorResponses },
      },
    },

    // ─── Complaints ──────────────────────────────────────────────────
    '/complaints': {
      post: {
        tags: ['Complaints'],
        summary: 'File complaint (multipart; up to 5 images)',
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['category', 'description'],
                properties: {
                  category: { type: 'string', enum: ['safety', 'fraud', 'rudeness', 'no_show', 'other'] },
                  description: { type: 'string', minLength: 3, maxLength: 2000 },
                  targetUserId: { type: 'string', format: 'uuid' },
                  targetTripId: { type: 'string', format: 'uuid' },
                  attachments: { type: 'array', items: { type: 'string', format: 'binary' } },
                },
              },
            },
          },
        },
        responses: { '201': { description: 'Filed' }, ...errorResponses },
      },
    },
    '/complaints/my': {
      get: {
        tags: ['Complaints'],
        summary: 'My filed complaints',
        parameters: [
          { name: 'cursor', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50 } },
        ],
        responses: { '200': { description: 'OK' }, ...errorResponses },
      },
    },

    // ─── Admin ───────────────────────────────────────────────────────
    '/admin/verifications': {
      get: {
        tags: ['Admin'],
        summary: 'Verification queue (FIFO, SLA breach flagged)',
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'cursor', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
        ],
        responses: { '200': { description: 'OK' }, ...errorResponses },
      },
    },
    '/admin/verifications/{id}': {
      get: {
        tags: ['Admin'],
        summary: 'Verification detail',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'OK' }, ...errorResponses },
      },
    },
    '/admin/verifications/{id}/approve': {
      patch: {
        tags: ['Admin'],
        summary: 'Approve (adds driver role, notifies)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'OK' }, ...errorResponses },
      },
    },
    '/admin/verifications/{id}/reject': {
      patch: {
        tags: ['Admin'],
        summary: 'Reject (reason required)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', minLength: 3 } } },
            },
          },
        },
        responses: { '200': { description: 'OK' }, ...errorResponses },
      },
    },
    '/admin/verifications/{id}/request-docs': {
      patch: {
        tags: ['Admin'],
        summary: 'Request specific re-uploads',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['docs'],
                properties: {
                  docs: { type: 'array', items: { type: 'string', enum: ['license', 'car_passport', 'car_photo', 'selfie'] } },
                  note: { type: 'string' },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'OK' }, ...errorResponses },
      },
    },
    '/admin/users': {
      get: {
        tags: ['Admin'],
        summary: 'List users with filters',
        parameters: [
          { name: 'q', in: 'query', schema: { type: 'string' } },
          { name: 'role', in: 'query', schema: { type: 'string', enum: ['passenger', 'driver'] } },
          { name: 'blocked', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } },
          { name: 'sort', in: 'query', schema: { type: 'string', enum: ['created_desc', 'created_asc', 'rating_desc', 'rating_asc'] } },
          { name: 'cursor', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
        ],
        responses: { '200': { description: 'OK' }, ...errorResponses },
      },
    },
    '/admin/users/{id}': {
      get: {
        tags: ['Admin'],
        summary: 'User detail',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'OK' }, ...errorResponses },
      },
    },
    '/admin/users/{id}/block': {
      patch: {
        tags: ['Admin'],
        summary: 'Block user (revokes refresh tokens)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['reason'], properties: { reason: { type: 'string' } } },
            },
          },
        },
        responses: { '200': { description: 'OK' }, ...errorResponses },
      },
    },
    '/admin/users/{id}/unblock': {
      patch: {
        tags: ['Admin'],
        summary: 'Unblock user',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'OK' }, ...errorResponses },
      },
    },
    '/admin/cities': {
      get: {
        tags: ['Admin'],
        summary: 'Cities (admin view)',
        responses: { '200': { description: 'OK' }, ...errorResponses },
      },
      post: {
        tags: ['Admin'],
        summary: 'Add city (superadmin)',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['nameRu', 'nameKg'],
                properties: {
                  nameRu: { type: 'string' },
                  nameKg: { type: 'string' },
                  region: { type: 'string' },
                  lat: { type: 'number' },
                  lng: { type: 'number' },
                  isActive: { type: 'boolean' },
                },
              },
            },
          },
        },
        responses: { '201': { description: 'Created' }, ...errorResponses },
      },
    },
    '/admin/cities/{id}': {
      patch: {
        tags: ['Admin'],
        summary: 'Update city (superadmin)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { '200': { description: 'OK' }, ...errorResponses },
      },
    },
    '/admin/admins': {
      get: {
        tags: ['Admin'],
        summary: 'List admins (superadmin)',
        responses: { '200': { description: 'OK' }, ...errorResponses },
      },
      post: {
        tags: ['Admin'],
        summary: 'Create admin (superadmin, forces password change)',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'name', 'password'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  name: { type: 'string' },
                  password: { type: 'string', minLength: 12 },
                  role: { type: 'string', enum: ['admin', 'superadmin'] },
                },
              },
            },
          },
        },
        responses: { '201': { description: 'Created' }, ...errorResponses },
      },
    },
    '/admin/audit-log': {
      get: {
        tags: ['Admin'],
        summary: 'Audit trail (admin=own, superadmin=all)',
        parameters: [
          { name: 'adminId', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'action', in: 'query', schema: { type: 'string' } },
          { name: 'cursor', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
        ],
        responses: { '200': { description: 'OK' }, ...errorResponses },
      },
    },
    '/admin/complaints': {
      get: {
        tags: ['Admin'],
        summary: 'Complaint queue',
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'category', in: 'query', schema: { type: 'string' } },
          { name: 'priority', in: 'query', schema: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] } },
          { name: 'cursor', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
        ],
        responses: {
          '200': {
            description: 'OK',
            content: { 'application/json': { schema: cursorPaginated('ComplaintListItem') } },
          },
          ...errorResponses,
        },
      },
    },
    '/admin/complaints/{id}': {
      get: {
        tags: ['Admin'],
        summary: 'Complaint detail',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'OK' }, ...errorResponses },
      },
    },
    '/admin/complaints/{id}/resolve': {
      patch: {
        tags: ['Admin'],
        summary: 'Resolve/dismiss complaint',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['status', 'resolution'],
                properties: {
                  status: { type: 'string', enum: ['resolved', 'dismissed'] },
                  resolution: { type: 'string', minLength: 3 },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'OK' }, ...errorResponses },
      },
    },
    '/admin/trips/{id}/cancel': {
      patch: {
        tags: ['Admin'],
        summary: 'Force-cancel a trip',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', minLength: 3 } } },
            },
          },
        },
        responses: { '200': { description: 'OK' }, ...errorResponses },
      },
    },
    '/admin/analytics/kpi': {
      get: {
        tags: ['Admin'],
        summary: 'KPI dashboard',
        responses: { '200': { description: 'OK', content: jsonOk('AdminKpi') }, ...errorResponses },
      },
    },
    '/admin/analytics/charts/{name}': {
      get: {
        tags: ['Admin'],
        summary: 'Chart data (registrations_by_day, trips_by_day, top_routes, activity_heatmap, rating_by_day, onboarding_funnel)',
        parameters: [
          {
            name: 'name',
            in: 'path',
            required: true,
            schema: {
              type: 'string',
              enum: [
                'registrations_by_day',
                'trips_by_day',
                'top_routes',
                'activity_heatmap',
                'rating_by_day',
                'onboarding_funnel',
              ],
            },
          },
        ],
        responses: { '200': { description: 'OK' }, ...errorResponses },
      },
    },
  },
} as const;

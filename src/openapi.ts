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
                  'OTP_BUDGET_EXCEEDED',
                  'CONTACT_LIMIT',
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
                  termsAcceptedAt: { type: 'string', format: 'date-time', nullable: true },
                },
              },
            },
          },
        ],
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
          bio: { type: 'string', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      SelfUser: {
        allOf: [
          { $ref: '#/components/schemas/PublicUser' },
          {
            type: 'object',
            properties: {
              surname: { type: 'string', nullable: true },
              preferredMode: { type: 'string', enum: ['passenger', 'driver'] },
              hasPassword: { type: 'boolean', description: 'Web sign-in password is set' },
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
      // A settlement of the SOATE directory. raion / oblast disambiguate
      // homonyms in pickers («Кара-Суу · Ноокенский район, Жалал-Абадская обл.»).
      Place: {
        type: 'object',
        required: ['id', 'type', 'nameRu', 'nameKg'],
        properties: {
          id: { type: 'integer' },
          type: { type: 'string', enum: ['capital', 'city', 'town', 'village', 'airport'] },
          nameRu: { type: 'string' },
          nameKg: { type: 'string' },
          lat: { type: 'number', nullable: true },
          lng: { type: 'number', nullable: true },
          raion: {
            type: 'object',
            nullable: true,
            properties: { nameRu: { type: 'string' }, nameKg: { type: 'string' } },
          },
          oblast: {
            type: 'object',
            nullable: true,
            properties: { nameRu: { type: 'string' }, nameKg: { type: 'string' } },
          },
        },
      },
      // Exact boarding / drop-off spot inside a settlement (map pin).
      MeetingPoint: {
        type: 'object',
        required: ['lat', 'lng'],
        properties: {
          lat: { type: 'number' },
          lng: { type: 'number' },
          address: { type: 'string', nullable: true, maxLength: 200 },
          area: {
            type: 'object',
            nullable: true,
            readOnly: true,
            description: 'Жилмассив of the pin (Бишкек / Ош), derived by the server',
            properties: { nameRu: { type: 'string' }, nameKg: { type: 'string' } },
          },
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
          kind: { type: 'string', enum: ['intercity', 'airport'] },
          originCityId: { type: 'integer' },
          destinationCityId: { type: 'integer' },
          originCity: { type: 'string', description: 'name_ru snapshot' },
          destinationCity: { type: 'string', description: 'name_ru snapshot' },
          origin: { $ref: '#/components/schemas/Place' },
          destination: { $ref: '#/components/schemas/Place' },
          originPoint: { allOf: [{ $ref: '#/components/schemas/MeetingPoint' }], nullable: true },
          pickupCities: { type: 'array', items: { type: 'string' } },
          departureAt: { type: 'string', format: 'date-time' },
          departureWindowEnd: { type: 'string', format: 'date-time', nullable: true },
          seatsAvailable: { type: 'integer' },
          pricePerSeat: { type: 'integer' },
          status: { type: 'string', enum: ['active', 'direct', 'completed', 'cancelled'] },
          liked: { type: 'boolean', description: 'Whether the requesting viewer liked this listing' },
          distanceKm: { type: 'number', description: 'Only with sort=nearest' },
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
          kind: { type: 'string', enum: ['intercity', 'airport'] },
          originCityId: { type: 'integer' },
          destinationCityId: { type: 'integer' },
          originCity: { type: 'string', description: 'name_ru snapshot' },
          destinationCity: { type: 'string', description: 'name_ru snapshot' },
          origin: { $ref: '#/components/schemas/Place' },
          destination: { $ref: '#/components/schemas/Place' },
          originPoint: { allOf: [{ $ref: '#/components/schemas/MeetingPoint' }], nullable: true },
          destinationPoint: { allOf: [{ $ref: '#/components/schemas/MeetingPoint' }], nullable: true },
          pickupCities: { type: 'array', items: { type: 'string' } },
          dropoffCities: { type: 'array', items: { type: 'string' } },
          stops: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['pickup', 'dropoff'] },
                place: { $ref: '#/components/schemas/Place' },
              },
            },
          },
          departureAt: { type: 'string', format: 'date-time' },
          departureWindowEnd: { type: 'string', format: 'date-time', nullable: true },
          departureFlexible: { type: 'boolean' },
          estimatedDurationMin: { type: 'integer' },
          seatsTotal: { type: 'integer' },
          seatsAvailable: { type: 'integer' },
          pricePerSeat: { type: 'integer' },
          priceNegotiable: { type: 'boolean' },
          luggage: { type: 'string', enum: ['yes', 'small', 'no'] },
          status: { type: 'string', enum: ['active', 'direct', 'completed', 'cancelled'] },
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
          trip: {
            type: 'object',
            description: 'originCity/destinationCity (name_ru snapshots) plus origin/destination place refs',
            properties: {
              originCityId: { type: 'integer' },
              destinationCityId: { type: 'integer' },
              origin: { $ref: '#/components/schemas/Place' },
              destination: { $ref: '#/components/schemas/Place' },
            },
          },
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
    '/auth/phone/login': {
      post: {
        tags: ['Auth'],
        summary: 'Web sign-in: phone + password (no WhatsApp code)',
        description:
          'Accounts created on mobile / in the Telegram bot have no password until '
          + 'they set one via /auth/phone/reset-password.',
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
        summary: 'Send a WhatsApp code (registration, mobile login, password reset)',
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
          '503': {
            description: 'OTP_BUDGET_EXCEEDED — daily OTP budget (global or non-+996) spent',
            content: jsonError,
          },
        },
      },
    },
    '/auth/phone/verify': {
      post: {
        tags: ['Auth'],
        summary: 'Mobile sign-in: phone + WhatsApp code',
        description: 'Existing accounts only — an unknown phone is 404, register it via /auth/register.',
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
    '/auth/check-phone': {
      post: {
        tags: ['Auth'],
        summary: 'Which sign-in step comes next for a phone',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['phone'], properties: { phone: { type: 'string' } } },
            },
          },
        },
        responses: {
          '200': {
            description: 'exists=false → register; hasPassword=false → set a password via WhatsApp (web)',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { exists: { type: 'boolean' }, hasPassword: { type: 'boolean' } },
                },
              },
            },
          },
          ...errorResponses,
        },
      },
    },
    '/auth/register': {
      post: {
        tags: ['Auth'],
        summary: 'Register a new number: WhatsApp code + name (+ password on web)',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['phone', 'code', 'name', 'surname'],
                properties: {
                  phone: { type: 'string' },
                  code: { type: 'string', pattern: '^\\d{6}$' },
                  name: { type: 'string', maxLength: 100 },
                  surname: { type: 'string', maxLength: 100 },
                  password: { type: 'string', minLength: 8, description: 'web only; must contain a digit' },
                  channel: { type: 'string', enum: ['mobile', 'web'] },
                },
              },
            },
          },
        },
        responses: { '201': { description: 'Created', content: jsonOk('AuthResult') }, ...errorResponses },
      },
    },
    '/auth/phone/reset-password': {
      post: {
        tags: ['Auth'],
        summary: 'Forgot password / first password — WhatsApp code to the account number',
        description: 'Revokes every session of the account.',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['phone', 'code', 'newPassword'],
                properties: {
                  phone: { type: 'string' },
                  code: { type: 'string', pattern: '^\\d{6}$' },
                  newPassword: { type: 'string', minLength: 8, description: 'must contain a digit' },
                },
              },
            },
          },
        },
        responses: { '204': { description: 'Password set' }, ...errorResponses },
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
    '/auth/admin/logout': {
      post: {
        tags: ['Auth'],
        summary: 'Admin sign-out: revokes admin refresh tokens and clears the cookie',
        description:
          'Public (works with an expired access token). With a valid admin refresh token '
          + '(terme_admin_rt cookie or body.refreshToken) it bumps the admin token epoch, revoking '
          + 'every admin refresh token of that admin; always clears the cookie. The client must also '
          + 'drop its in-memory access token.',
        security: [],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  refreshToken: { type: 'string' },
                  channel: { type: 'string', enum: ['mobile', 'web'] },
                },
              },
            },
          },
        },
        responses: { '204': { description: 'Signed out' }, ...errorResponses },
      },
    },
    '/auth/admin/totp/setup': {
      post: {
        tags: ['Auth'],
        summary: 'Admin TOTP enrolment step 1: new secret (stored pending, encrypted)',
        description:
          'Reachable while ADMIN_TOTP_REQUIRED gating is active. 409 totp_already_enabled if enrolled.',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': {
            description: 'Secret + otpauth:// URI for the authenticator app (render as QR)',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { secret: { type: 'string' }, otpauthUri: { type: 'string' } },
                },
              },
            },
          },
          ...errorResponses,
        },
      },
    },
    '/auth/admin/totp/confirm': {
      post: {
        tags: ['Auth'],
        summary: 'Admin TOTP enrolment step 2: verify a code → TOTP enabled',
        description:
          'Rotates the admin token epoch (other sessions end) and returns a fresh admin token pair '
          + '(web: refresh token in the terme_admin_rt cookie). 400 totp_invalid on a wrong code.',
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['code'],
                properties: {
                  code: { type: 'string', pattern: '^\\d{6}$' },
                  channel: { type: 'string', enum: ['mobile', 'web'] },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'AdminAuthResult (same shape as login)' }, ...errorResponses },
      },
    },
    '/auth/admin/totp/disable': {
      post: {
        tags: ['Auth'],
        summary: 'Disable admin TOTP (self with a current code, or superadmin for another admin)',
        description:
          'Self: { code }. Superadmin: { adminId } (audited as disable_admin_totp). Bumps the target '
          + 'admin token epoch — their refresh tokens are revoked.',
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  adminId: { type: 'string', format: 'uuid' },
                  code: { type: 'string', pattern: '^\\d{6}$' },
                },
              },
            },
          },
        },
        responses: { '204': { description: 'TOTP disabled' }, ...errorResponses },
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
                  surname: { type: 'string', maxLength: 100 },
                  bio: { type: 'string', maxLength: 300 },
                  language: { type: 'string', enum: ['ru', 'kg'] },
                  preferredMode: { type: 'string', enum: ['passenger', 'driver'] },
                  termsAccepted: { type: 'boolean', enum: [true] },
                  notificationsEnabled: { type: 'boolean' },
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
        summary: 'Change the password (current one required)',
        description:
          'No password yet → 409 password_not_set: use /auth/phone/reset-password. '
          + 'New password must be ≥8 chars and contain a digit. Every session is revoked; the '
          + 'response carries a fresh token pair (channel=web → refresh token in the HttpOnly cookie).',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['currentPassword', 'newPassword'],
                properties: {
                  currentPassword: { type: 'string' },
                  newPassword: {
                    type: 'string',
                    minLength: 8,
                    maxLength: 200,
                    description: 'must contain at least one digit',
                  },
                  channel: { type: 'string', enum: ['mobile', 'web'] },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Changed — fresh session', content: jsonOk('AuthResult') },
          ...errorResponses,
        },
      },
    },
    '/users/me/phone': {
      patch: {
        tags: ['Users'],
        summary: 'Start phone change — WhatsApp code to the NEW number',
        description:
          'The session authenticates the caller. Returns { expiresInSec: 600 }. '
          + 'Finish with PATCH /users/me/phone/confirm.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['newPhone'],
                properties: {
                  newPhone: { type: 'string', example: '+996700111333' },
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
        summary: 'Settlements autocomplete (RU / KG / Latin / wrong layout); no q → top places',
        security: [],
        parameters: [
          { name: 'q', in: 'query', schema: { type: 'string', maxLength: 100 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 20 } },
        ],
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { data: { type: 'array', items: { $ref: '#/components/schemas/Place' } } } },
              },
            },
          },
        },
      },
    },
    '/cities/airports': {
      get: {
        tags: ['Cities'],
        summary: 'Airports with the city each one serves (airport transfers)',
        security: [],
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'array',
                      items: {
                        allOf: [
                          { $ref: '#/components/schemas/Place' },
                          {
                            type: 'object',
                            properties: {
                              serves: { allOf: [{ $ref: '#/components/schemas/Place' }], nullable: true },
                            },
                          },
                        ],
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/cities/nearest': {
      get: {
        tags: ['Cities'],
        summary: 'The settlement a GPS point is in (prefills «Откуда»)',
        security: [],
        parameters: [
          { name: 'lat', in: 'query', required: true, schema: { type: 'number' } },
          { name: 'lng', in: 'query', required: true, schema: { type: 'number' } },
        ],
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { data: { allOf: [{ $ref: '#/components/schemas/Place' }], nullable: true } },
                },
              },
            },
          },
          ...errorResponses,
        },
      },
    },
    '/cities/{id}/spots': {
      get: {
        tags: ['Cities'],
        summary: 'Pin picker inside Бишкек / Ош: departure spots, then жилмассивы (draggable)',
        security: [],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
          { name: 'q', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'OK (empty for other places)',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          kind: { type: 'string', enum: ['spot', 'area'] },
                          nameRu: { type: 'string' },
                          nameKg: { type: 'string' },
                          lat: { type: 'number' },
                          lng: { type: 'number' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/map': {
      get: {
        tags: ['Map'],
        summary: 'Trips / requests in a viewport, grid-clustered by zoom',
        description:
          'Each listing sits at its exact pin (driver boarding spot / where the passenger waits) or, '
          + 'without one, its settlement (exact=false). Cells holding one listing come back as items, '
          + 'denser cells as clusters. No clustering from zoom 14.',
        security: [],
        parameters: [
          { name: 'kind', in: 'query', required: true, schema: { type: 'string', enum: ['trips', 'requests'] } },
          { name: 'bbox', in: 'query', required: true, schema: { type: 'string', example: '74.4,42.8,74.8,42.95' }, description: 'west,south,east,north' },
          { name: 'zoom', in: 'query', required: true, schema: { type: 'integer', minimum: 3, maximum: 20 } },
          { name: 'to_id', in: 'query', schema: { type: 'integer' } },
          { name: 'ride', in: 'query', schema: { type: 'string', enum: ['intercity', 'airport'] } },
          { name: 'date', in: 'query', schema: { type: 'string', format: 'date-time' } },
        ],
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    items: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          id: { type: 'string', format: 'uuid' },
                          lat: { type: 'number' },
                          lng: { type: 'number' },
                          exact: { type: 'boolean' },
                          originCity: { type: 'string' },
                          destinationCity: { type: 'string' },
                          destinationCityId: { type: 'integer' },
                          departureAt: { type: 'string', format: 'date-time' },
                          seats: { type: 'integer' },
                          price: { type: 'integer', nullable: true },
                        },
                      },
                    },
                    clusters: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: { lat: { type: 'number' }, lng: { type: 'number' }, count: { type: 'integer' } },
                      },
                    },
                  },
                },
              },
            },
          },
          ...errorResponses,
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
          { name: 'from_id', in: 'query', schema: { type: 'integer' } },
          { name: 'to_id', in: 'query', schema: { type: 'integer' } },
          { name: 'from_city', in: 'query', schema: { type: 'string' }, description: 'Name fallback (SEO / bot) when no from_id' },
          { name: 'to_city', in: 'query', schema: { type: 'string' }, description: 'Name fallback when no to_id' },
          { name: 'near_lat', in: 'query', schema: { type: 'number' }, description: 'Viewer point for sort=nearest' },
          { name: 'near_lng', in: 'query', schema: { type: 'number' } },
          { name: 'date', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'seats', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 4 } },
          { name: 'min_price', in: 'query', schema: { type: 'integer' } },
          { name: 'max_price', in: 'query', schema: { type: 'integer' } },
          { name: 'only_verified', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } },
          { name: 'luggage', in: 'query', schema: { type: 'string', enum: ['yes', 'small', 'no'] } },
          { name: 'kind', in: 'query', schema: { type: 'string', enum: ['intercity', 'airport'] }, description: 'airport = transfers' },
          { name: 'women_only', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } },
          { name: 'no_smoking', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } },
          { name: 'pets', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } },
          { name: 'sort', in: 'query', schema: { type: 'string', enum: ['time', 'price_asc', 'rating_desc', 'nearest'] } },
          { name: 'cursor', in: 'query', schema: { type: 'string' }, description: 'Opaque' },
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
                required: ['originCityId', 'destinationCityId', 'departureAt', 'seatsTotal', 'pricePerSeat'],
                properties: {
                  originCityId: { type: 'integer' },
                  destinationCityId: { type: 'integer' },
                  originPoint: { $ref: '#/components/schemas/MeetingPoint' },
                  destinationPoint: { $ref: '#/components/schemas/MeetingPoint' },
                  pickupCityIds: { type: 'array', items: { type: 'integer' }, maxItems: 5 },
                  dropoffCityIds: { type: 'array', items: { type: 'integer' }, maxItems: 5 },
                  carId: { type: 'string', format: 'uuid' },
                  departureAt: { type: 'string', format: 'date-time' },
                  departureWindowEnd: { type: 'string', format: 'date-time' },
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
        responses: {
          '200': {
            description: 'OK — { data: (TripListItem + comment)[], nextCursor }',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'array',
                      items: {
                        allOf: [
                          { $ref: '#/components/schemas/TripListItem' },
                          { type: 'object', properties: { comment: { type: 'string', nullable: true } } },
                        ],
                      },
                    },
                    nextCursor: { type: 'string', nullable: true },
                  },
                },
              },
            },
          },
          ...errorResponses,
        },
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
                  preferences: { type: 'object', description: 'Merged into the stored preferences' },
                  originPoint: { allOf: [{ $ref: '#/components/schemas/MeetingPoint' }], nullable: true },
                  destinationPoint: { allOf: [{ $ref: '#/components/schemas/MeetingPoint' }], nullable: true },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'OK', content: jsonOk('TripDetail') }, ...errorResponses },
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
          { name: 'from_id', in: 'query', required: true, schema: { type: 'integer' } },
          { name: 'to_id', in: 'query', required: true, schema: { type: 'integer' } },
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
        summary: 'Driver\'s incoming requests (pending by default)',
        parameters: [
          { name: 'tripId', in: 'query', schema: { type: 'string', format: 'uuid' } },
          {
            name: 'status',
            in: 'query',
            description: 'pending = pending+viewed (default), accepted, all = both',
            schema: { type: 'string', enum: ['pending', 'accepted', 'all'], default: 'pending' },
          },
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
        summary: 'Search the SOATE directory (approx=true → points to fix by hand)',
        parameters: [
          { name: 'q', in: 'query', schema: { type: 'string' } },
          { name: 'type', in: 'query', schema: { type: 'string' } },
          { name: 'approx', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } },
          { name: 'cursor', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
        ],
        responses: { '200': { description: 'OK' }, ...errorResponses },
      },
    },
    '/admin/cities/{id}': {
      patch: {
        tags: ['Admin'],
        summary: 'Correct a place: names, aliases, map point, visibility (superadmin)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  nameRu: { type: 'string' },
                  nameKg: { type: 'string' },
                  aliases: { type: 'array', items: { type: 'string' } },
                  lat: { type: 'number' },
                  lng: { type: 'number' },
                  isActive: { type: 'boolean' },
                },
              },
            },
          },
        },
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

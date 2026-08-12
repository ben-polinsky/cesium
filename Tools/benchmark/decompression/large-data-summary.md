# Large-data decompression audit

## Result

Large-production validation is **partially complete**. The exact 12-pair
Re:Earth Meshopt route now provides valid large-stream evidence. SPZ,
Draco/KTX2, Meshopt terrain, I3S Draco, and stress-level memory validation
remain open.

The machine-readable inventory is
[`large-asset-corpus.json`](./large-asset-corpus.json).

## Codec evidence

| Codec/workload             |                            Compressed bytes |                       Estimated decoded bytes | Views/tasks                                                             | Readiness/frame continuity            | Memory/failures                | Status                                      |
| -------------------------- | ------------------------------------------: | --------------------------------------------: | ----------------------------------------------------------------------- | ------------------------------------- | ------------------------------ | ------------------------------------------- |
| Re:Earth Meshopt route     | 1,525,862,980 across 1,403 GLBs              | 2,941,171,106 estimated decoded buffer bytes | 31,464 views; 4,104 Meshopt views; 360 stops                            | Candidate − baseline: -11.5 s readiness; -24.6 ms maximum frame gap | Candidate heap +5.1 MB median; geometry unchanged; 2,170 response errors | Valid 12-pair route; upstream 404/503 responses retained |
| Ion SPZ 4547222            | 2,345,454,852 transferred across 3,410 GLBs | Not retained; SPZ output size was not derived | 62-task selected-view diagnostic; 656 tasks in partial public traversal | No valid exact-ref 1 GB paired result | Browser memory API unavailable | Corpus inventory complete; paired route gap |
| Ion Draco/KTX2 2325107     |          3,437,249,260 reported; 3,902 GLBs |                               Not inventoried | Not benchmarked                                                         | No paired result                      | No memory/failure result       | Production format confirmed; route gap      |
| Meshopt terrain            |                                     Unknown |                                       Unknown | None                                                                    | None                                  | None                           | No confirmed source                         |
| I3S Draco                  |                                     Unknown |                                       Unknown | Public payloads followed binary path in inspected cases                 | None                                  | None                           | No confirmed stable corpus                  |
| Grand Court iModel control |                        34,106,492 local GLB |                                Not calculated | 17 bufferViews, 2 primitives                                            | No paired result                      | None                           | Medium BIM control; not Meshopt             |

## Exact confirmatory comparison

The valid exact-ref report uses baseline
`6d5d8b1f0725b6f831b336463f4b11c98023427b` and candidate
`7e620929194becfe04c5ad019c030159cfe0aa34`, with fresh minified builds and
12 paired blocks:

| Scenario            | Candidate readiness delta |    Candidate frame-gap delta |
| ------------------- | ------------------------: | ---------------------------: |
| Meshopt unit square |           +23.5 ms median |               Not applicable |
| Meshopt cube        |          +23.15 ms median |               Not applicable |
| SPZ tower           |           +10.7 ms median | -141.6 ms median maximum gap |

These are first-use and medium-fixture results. They do not establish
large-data throughput, memory safety, or bufferView-count scaling.

## Exact Re:Earth large-stream comparison

The route used the public Re:Earth Buildings tileset with a fixed 1280×720
viewport, `maximumScreenSpaceError: 8`, 2500 m camera height, 360 deterministic
stops, fresh browser contexts, fresh minified builds, and alternating
candidate-first/baseline-first order. The exact refs were the same as the
confirmatory comparison, with 12 paired blocks.

Every sample processed more than 1 GB of unique compressed GLBs. The retained
route inventory contains 1,403 successful GLBs totaling 1,525,862,980
compressed bytes and 2,941,171,106 estimated decoded buffer bytes. The
candidate-minus-baseline paired medians were:

| Metric | Candidate minus baseline |
| --- | ---: |
| Route readiness | -11,494.7 ms |
| Maximum frame gap | -24.6 ms |
| P95 frame gap | -0.3 ms |
| Long-task count | -3 |
| Peak page JavaScript heap | +5,063,189 bytes |
| Peak Cesium geometry memory | 0 bytes |

The public route referenced missing content: 2,167 HTTP 404 responses and
three HTTP 503 responses across the 24 samples. These were not filtered from
the report; candidate and baseline experienced comparable response-error
counts.

## Repository audit

The repository's performance guide recommends fixed camera/viewport settings,
release builds, explicit cache and network policy, `initialTilesLoaded` for
fixed-view readiness, static CORS-enabled serving, and disabling unrelated
rendering work. The Sandcastle performance examples and local fixtures were
reviewed against those recommendations.

The repository-local inventory contains approximately 739 relevant binary/data
files totaling roughly 61.9 MB. The largest local GLBs are approximately
11.9 MB. No production-scale individual Meshopt GLB or Meshopt terrain payload
is present locally.

The reviewed large public candidates include:

- Re:Earth buildings: confirmed Meshopt streamed content.
- Ion 4547222: complete 2.345 GB SPZ corpus.
- Ion 2325107: complete 3.437 GB Draco/KTX2 corpus.
- GTOPO30, Yemen CDB, Montreal point cloud, NYC/AGI/Melbourne B3DM, Bentley
  Power Plant, S2 Globe, and San Francisco Ferry Building: useful non-Meshopt
  controls or alternate codec workloads.

## Interpretation

The strongest supported product conclusion is now broader but still bounded:
workerized decoding adds a repeatable first-use cost on small/medium assets,
improves the SPZ fixture's worst frame continuity, and shows lower readiness,
maximum frame gaps, and long-task counts on the exact Re:Earth Meshopt stream.
The candidate's median page heap was slightly higher while Cesium geometry
memory was unchanged. SPZ, Draco/KTX2, terrain, I3S Draco, individual
high-bufferView scaling, and stress-level memory behavior remain unvalidated.

Do not claim that the redesign has passed all large-production validation until
the remaining gaps in `large-asset-corpus.json` are closed.

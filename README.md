# MadeForMars 

Mars is unfamiliar, and an astronaut walking there can only go as far as the oxygen on their back allows. MadeForMars is like Google Maps for Mars: it helps astronauts plan a walk and practise it before they ever step outside. You start on a 3D Mars made from NASA’s own maps and photos, where the app suggests the best places to explore. Zoom into one of five real spots that NASA rovers have visited, choose the places you want to see, and it draws the safest path there and back, avoiding steep ground and making sure you’ll get home before your oxygen runs low. Then you take the walk in a simulation. If something goes wrong, like a solar storm or a leaking suit, it instantly finds the nearest shelter, and afterwards you can replay everything that happened. Before the first person walks on Mars, they should already know the way. Plan your route at made-for-mars.us.

### Project: 
https://www.made-for-mars.us/

### Project Details
###### What it does?

MadeForMars is a map for planning a walk on Mars and rehearsing it before anyone steps outside. Start on a 3D globe of Mars, pick a site, click the places you want to visit and walk on, and it plans a safe route there and back. Then you walk the route in a simulation, deal with emergencies along the way, and watch a replay of what happened. Live demo is available at: made-for-mars.us. 

###### How does it work?

The globe of Mars and the background sky is rebuilt from NASA data. A score ranks NASA’s 47 candidate human landing zones by science value, safety and ease of access, and you can change the weights of the scoring criteria. Five sites have real 1 km terrain from the HiRISE camera in orbit. Every square metre gets a slope and a roughness value, and ground steeper than 25° is marked as no-go, preventing astronauts from going on dangerous missions. 

When you pick stops, an A* search finds the best path between them, and a slider trades speed against safety. Before you can start, the route is checked against four limits: oxygen (including a 30-minute reserve), radiation dose, steepest slope, and the walk-back limit, meaning how far you can go and still get home.

During the walk, a suit model updates oxygen, CO₂, work rate, suit temperature, battery and dose every second. If you inject a solar storm or a suit leak, the app re-plans to the nearest shelter in about 20 ms. If you pass the point of no return, it warns you. If oxygen runs out, the mission fails. Every second is logged, so the debrief can replay the walk and name the first limit that was crossed.

###### What was built?

A 3D Mars globe with real stars, the real Sun for today’s date, and switchable layers for minerals, geology, thermal inertia, dust and seasonal weather.
Five walkable sites: Jezero (Perseverance), two in Gale Crater (Curiosity), Home Plate (Spirit) and Cape York (Opportunity).
A 3D scan at each site, rebuilt from that rover’s own photos with Gaussian splatting and placed on the orbital terrain.
A route planner with pins, notes, safety limits, an elevation profile and alternative routes.
A walk simulation with a rigged, animated astronaut, live vitals and emergency incidents.
A debrief with a replay timeline, charts and an automatic summary.
Benefits and Intended Impact

Mars is unfamiliar, and a walk there is limited by the oxygen on your back. NASA has collected decades of data about the planet, but the tools that show it are built for whole regions, not the kilometre an astronaut covers on foot. MadeForMars brings that data down to walking scale and answers the question a crew actually has: can we get there and back safely?

Mission planners could use it to compare routes and test what happens when things go wrong. Crews could use it to rehearse a walk before launch, so the first time on the ground isn’t the first time on the route. Because it runs in a browser, students and anyone curious can also open it and see what planning a real Marswalk involves.

The pipeline to build terrain is also reusable, with a few images, we can recreate terrain using 3DGS algorithm and add on more walkable sites using rover images, making the project easily expandable and scalable for real life testing and usage. 

###### Creativity

The 3D scans come straight from the rovers. NASA stores a camera model with each rover image, so we could place every photo exactly instead of estimating camera positions. The Jezero scan lines up with the orbital terrain to within 16 cm, and the camera spacing we recovered matches the published value to within 0.16%.

The sky is accurate as well. The Sun’s position comes from NASA GISS’s Mars24 algorithm, and 9,096 stars from the Yale Bright Star Catalogue are placed as they would appear from Mars. We also borrowed from Google Maps (pins, place cards and notes) so planning feels familiar from the start. Then we added what Google Maps never needs: an oxygen budget and a point of no return.

###### Factors Considered

Safety came first. No route can start without passing the oxygen, slope, dose and walk-back checks, and anyone who overrides the warning has to confirm.

We built the models around a person in a suit. Oxygen supply is sized from NASA’s spacesuit design workload of about 293 W. Effort comes from the Pandolf load-carriage equation, scaled to Mars gravity. Radiation is calibrated to the dose Curiosity measured on the surface, 0.67 mSv per day.

We were honest about the limits of the data. Global maps are kilometre-scale, so they only rank regions, and walking safety always comes from the 1 km terrain. Anything modelled is labelled “model” in the app. Missing data shows as blank, never as zero.

Finally, we kept the interface simple: one map, one accent colour, and a layout that still works on a small screen.

###### Tools, Coding Languages, Software and Hardware

Languages: TypeScript for the app, Python for the data pipelines.
App: three.js for 3D, Spark for rendering the Gaussian splats, Vite as the build tool.
Data processing: rasterio and GDAL for terrain, NumPy and SciPy for slope, roughness and route costs, pyproj for map projections.
3D scans: PyTorch with gsplat for training (we patched gsplat to build on Windows with CUDA 13), pycolmap and Open3D for points and alignment.
Hosting: Vercel, with the roughly 310 MB of terrain, scans and globe data stored in Git LFS on GitHub.
Hardware: one Windows 11 laptop with an RTX 5070 GPU (8 GB).
Data: 39 credited datasets, including HiRISE terrain, MOLA elevation, the Viking colour mosaic, TES mineral and thermal maps, the USGS geologic map, the IAU place-name gazetteer, rover images, NASA’s DONKI space-weather feed, and the Mars Climate Database for seasonal weather.
